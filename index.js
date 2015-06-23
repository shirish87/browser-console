'use strict';

var _ = require('highland');
var webdriver = require('selenium-webdriver');
var ngrok = require('ngrok');
var debug = require('diagnostics')('bc:main');

var repl = require('./repl');
var server = require('./server');
var PrimusClient = require('./client');

// TODO: Accept and parse command-line args
var options = {
  clientPageTitle: 'browser-console',
  capabilities: {
    browser: 'chrome',
    browserVersion: '36.0',
    os: 'Windows',
    osVersion: '7'
  }
};


var config = {};
config.websocket = {
  engine: 'engine.io'
};

config.browserstack = {
  hub: 'http://hub.browserstack.com/wd/hub',
  user: process.env.BROWSERSTACK_USERNAME,
  key: process.env.BROWSERSTACK_KEY
};

config.port = 8080;
config.openTimeout = 60000;
config.keepAliveInterval = 30000;

boot(config, options);


function boot(config, options) {
  var replStream = repl.start(config);
  var createTunnel = _.wrapCallback(ngrok.connect);

  server.start(config, replStream, function (err, primus, dataStream) {
    if (err) { throw err; }
    debug('Started server');

    var client = new PrimusClient(primus);

    var useWd = !!(options && options.capabilities);
    var wdKeepAliveHandle;
    debug('Using Selenium WebDriver: %s', useWd);

    var wd = useWd ? initWebDriver(config, options.capabilities) : null;

    // there's a good chance multiple conditions will cause termination
    // at almost the same time
    var isTerminated = false;

    /**
    * Terminate all components and exit the process
    */
    var terminate = function (exitCode) {
      if (!isTerminated) {
        debug('terminate');
        isTerminated = true;
        exitCode = exitCode || 0;

        var exit = function () {
          process.exit(exitCode);
        };

        try {
          replStream.destroy();
          dataStream.destroy();
        } catch (e) {
          // either or both streams may have already been terminated
        }

        if (!wd) {
          return exit();
        }

        if (wdKeepAliveHandle) {
          clearInterval(wdKeepAliveHandle);
        }

        debug('Terminating WebDriver');
        wd.quit().then(function () {
          exit();
        }).then(null, function (err) {
          debug('Error terminating WebDriver', err);
          exit();
        });
      }
    };

    replStream.fork().done(function () {
      terminate(0);
    });

    dataStream.fork()
      .each(function (data) {
        if (typeof data === 'object' && data.console) {
          clientConsolePrint(data.console);
        }
      })
      .done(function () {
        terminate(1);
      });

    _([
      function (callback) {
        ngrok.connect(config.port, callback);
        debug('Creating tunnel');
      },
      function (callback) {
        client.build(callback);
        debug('Building client');
      }
    ]).nfcall([])
      .parallel(2)
      .toArray(function (res) {
        debug('Tunnel and client ready');

        var url = res.shift();
        client.export(url, function (err) {
          if (err) {
            console.error(err);
            return terminate(1);
          }

          if (wd) {
            debug('Opening URL: %s', url);
            wd.get(url);

            if (config.keepAliveInterval && config.keepAliveInterval > 0) {
              wdKeepAliveHandle = setInterval(function () {
                wd.executeScript('return 1').then(function(res) {
                  debug('Keep-Alive: %s', res);
                }).then(null, function (err) {
                  debug('Failed to send/receive keep-alive', err);
                  terminate(1);
                });
              }, config.keepAliveInterval);
            }

            var checkTitle = webdriver.until.titleIs(options.clientPageTitle);
            wd.wait(checkTitle, config.openTimeout).then(function () {
              debug('Opened URL: %s', url);
              console.log('Ready.\n');
            }).then(null, function (err) {
              debug('Failed to open URL', err);
              terminate(1);
            });
          }
        });
      });
  });

}


function clientConsolePrint(c) {
  debug('client console.%s', c.method);
  console[c.method].apply(console, c.arguments);
}


function initWebDriver(config, caps) {
  var capabilities;

  // TODO: Needs to be as per -
  // https://www.browserstack.com/automate/capabilities
  if (caps.device) {
    capabilities = {
      'browser': caps.browser,
      'device': caps.device,
      'deviceOrientation': caps.deviceOrientation,
      'os': caps.os
    };
  } else {
    capabilities = {
      'browser': caps.browser,
      'browser_version': caps.browserVersion,
      'os': caps.os,
      'os_version': caps.osVersion
    };
  }

  // Selenium requires 'browserName'
  capabilities.browserName = capabilities.browser;

  capabilities['browserstack.user'] = config.browserstack.user;
  capabilities['browserstack.key'] = config.browserstack.key;

  var wd = new webdriver.Builder()
    .usingServer(config.browserstack.hub)
    .withCapabilities(capabilities)
    .build();

  return wd;
}
