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

config.client = {
  useCache: true,
  path: 'public',
  mainHtml: 'index.html',
  cacheHtml: 'cache.html',
  clientJs: 'client.js',
  utilJs: 'util.js'
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

  server.start(config, replStream, function (err, primus, dataStream) {
    if (err) { throw err; }
    debug('Started server');

    var useWd = !!(options && options.capabilities);
    debug('Using Selenium WebDriver: %s', useWd);

    var wd = useWd ? initWebDriver(config, options.capabilities) : null;
    var terminate = terminateFn(wd, [ replStream, dataStream ]);

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
        createTunnel(config),
        createClient(config, primus)
      ])
      .nfcall([])
      .parallel(2)
      .errors(function (err, push) {
        push(null, {}); // don't propagate

        // meh, we gotta die
        console.log(err);
        terminate(1);
      })
      .apply(function (url, client) {
        debug('Tunnel and client ready');

        client.exportFile(url, function (err) {
          if (err) {
            console.error('export', err);
            return terminate(1);
          }

          if (wd) {
            startWdSession(config, wd, url);
          }
        });
      });
  });
}


function createTunnel(config) {
  return function (callback) {
    debug('Creating tunnel');

    ngrok.connect(config.port, function (err, url) {
      debug('Tunnel ready');
      callback(err, url);
    });
  };
}


function createClient(config, primus) {
  var client = new PrimusClient(config, primus);

  return function (callback) {
    debug('Building client');

    client.build(function (err) {
      debug('Client ready');
      callback(err, client);
    });
  };
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


function startWdSession(config, wd, url, terminate) {
  var wdKeepAliveHandle;

  debug('Opening URL: %s', url);
  wd.get(url);

  if (config.keepAliveInterval && config.keepAliveInterval > 0) {
    wd.keepAliveHandle = setInterval(function () {
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


function terminateFn(wd, streams) {
  streams = streams || [];

  // there's a good chance multiple conditions will cause termination
  // at almost the same time
  var isTerminated = false;

  /**
  * Terminate all components and exit the process
  */
  return function terminate(exitCode) {
    if (!isTerminated) {
      debug('terminate');
      isTerminated = true;
      exitCode = exitCode || 0;

      var exit = function () {
        process.exit(exitCode);
      };

      streams.forEach(function (s) {
        try {
          s.destroy();
        } catch (e) {
          // either or all streams may have already been terminated
        }
      });

      if (!wd) {
        return exit();
      }

      if (wd.keepAliveHandle) {
        clearInterval(wd.keepAliveHandle);
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
}
