'use strict';

var _ = require('highland');
var webdriver = require('selenium-webdriver');
var ngrok = require('ngrok');
var https = require('https');
var fs = require('fs');
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
  key: process.env.BROWSERSTACK_KEY,

  update: {
    browserJson: 'browsers.json',
    endpoint: {
      hostname: 'www.browserstack.com',
      port: '443',
      method : 'GET',
      path: '/automate/browsers.json'
    }
  }
};

config.port = 8080;
config.openTimeout = 60000;
config.keepAliveInterval = 30000;

boot(config, options);


function boot(config, options) {
  repl.print('Please wait…');

  var browsers = [];
  getOrFetchBrowsers(config, function (err, bs) {
    if (Array.isArray(bs) && bs.length) {
      browsers = bs;
    }
  });

  var replStream = repl.start(config);
  // repl.hideCursor();

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
            startWdSession(config, wd, url, terminate);
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
    repl.print('Ready', true);
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


function getOrFetchBrowsers(config, callback) {
  var browserJsonPath = config.browserstack.update.browserJson;

  fs.stat(browserJsonPath, function (err, stat) {
    // TODO: Get files last-modified time and update periodically
    var browserJsonExists = (stat && stat.isFile());

    var browsers = browserJsonExists ? require('./' + browserJsonPath) : [];

    if (!Array.isArray(browsers) || !browsers.length) {
      debug('Fetching', browserJsonPath);
      return fetchAutomateBrowsers(config, callback);
    }

    debug('Reusing', browserJsonPath);
    callback(null, browsers);
  });
}


function fetchAutomateBrowsers(config, callback) {
  var user = config.browserstack.user;
  var key = config.browserstack.key;
  var outFile = config.browserstack.update.browserJson;

  var opts = _.extend({
    auth: user + ':' + key
  }, config.browserstack.update.endpoint);

  jsonRequestStream(opts)
    .errors(function (err, push) {
      push(null, {});
      callback(err);
    })
    .apply(function (browsers) {
      if (!browsers || !browsers.length) {
        return callback(null, []);
      }

      _([ browsers ])
        .map(function (obj) {
          return JSON.stringify(obj, null, 2);
        })
        .pipe(fs.createWriteStream(outFile))
        .on('error', callback)
        .on('finish', function () {
          debug('Fin');
          callback(null, browsers);
        });
    });
}


function jsonRequestStream(options) {
  return _(function (push) {
    var req = https.request(options, function (res) {
      _(res)
        .errors(function (err, next) {
          next(null);
          push(err);
        })
        .reduce1(function (a, b) {
          return a + b;
        })
        .apply(function (body) {
          try {
            push(null, JSON.parse(body));
            push(null, _.nil);
          } catch (e) {
            push(e);
          }
        });
    });

    req.on('error', push);
    req.end();
  });
}
