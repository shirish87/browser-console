#!/usr/bin/env node
'use strict';

var yargs = require('yargs');
var _ = require('highland');
var webdriver = require('selenium-webdriver');
var ngrok = require('ngrok');
var https = require('https');
var fs = require('fs');
var path = require('path');
var debug = require('diagnostics')('bc:main');

var repl = require('./repl');
var server = require('./server');
var PrimusClient = require('./client');


var config = {};

config.websocket = {
  engine: 'engine.io'
};

config.client = {
  pageTitle: 'browser-console',
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

  getCapabilities: function (caps) {
    // TODO: Needs to be as per -
    // https://www.browserstack.com/automate/capabilities
    var user = this.user;
    var key = this.key;

    var attrs = [
      'browser',
      'os',
      'os_version'
    ];

    if (caps.device) {
      attrs.push('device');
      attrs.push('deviceOrientation');
    } else {
      attrs.push('browser_version');
    }

    return attrs.reduce(function (o, k) {
      if (caps[k]) {
        o[k] = caps[k];
      }

      return o;
    }, {
      'browserstack.user': user,
      'browserstack.key': key
    });
  },

  update: {
    browserJson: path.join(__dirname, 'browsers.json'),
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



(function init(config) {

  var argParser = yargs
    .usage('Usage: $0 <browser> [device] <os>')
    .demand(2, 'Missing <browser> or <os>.')
    .example('export BROWSERSTACK_USERNAME=<username>')
    .example('export BROWSERSTACK_KEY=<access-key>')
    .example('$0 chrome-36 windows-7', 'Opens a console session with Chrome 36 on Windows 7 running remotely on BrowserStack.')
    .help('h')
    .alias('h', 'help');

  var argv = argParser.argv;

  [ 'BROWSERSTACK_USERNAME', 'BROWSERSTACK_KEY' ].forEach(function (k) {
    if (!process.env[k]) {
      argParser.showHelp();
      console.log('Missing required environment variable: %s', k);
      process.exit(1);
    }
  });

  repl.print('… Loading …');

  // TODO: loading browsers takes longer than anticipated
  getOrFetchBrowsers(config, function (err, bh) {
    var caps;

    if (typeof bh === 'object') {
      debug('Loaded browsers');

      var k = getBrowserHashKey(argv._.map(function (s) {
        return s.replace(/\-/g, '|');
      }));

      caps = bh[k];
      if (caps) {
        debug('Found requested browser');
        return boot(config, {
          id: k,
          capabilities: caps
        });
      }
    }

    if (argv._ && argv._.length >= 2) {
      var len = argv._.length;
      var browserParts = argv._.shift().split('-');
      var device = (len >= 3) ? argv._.shift() : null;
      var osParts = argv._.shift().split('-');

      if (device) {
        // device
        caps = {
          'browser': browserParts.shift(),
          'device': device,
          'os': osParts.shift(),
          'os_version': osParts.shift()
        };

      } else if (len === 2) {
        // browser
        caps = {
          'browser': browserParts.shift(),
          'browser_version': browserParts.shift(),
          'os': osParts.shift(),
          'os_version': osParts.shift()
        };
      }

      return boot(config, {
        id: getBrowserId(caps),
        capabilities: caps
      });
    }

    repl.print('Invalid arguments.');
  });

})(config);



function boot(config, options) {
  var replStream = repl.start(config);
  repl.print('… Starting server …');

  server.start(config, replStream, function (err, primus, dataStream) {
    if (err) { throw err; }
    debug('Started server');

    var useWd = !!(options && options.capabilities);
    debug('Using Selenium WebDriver: %s', useWd);

    var wd = useWd && initWebDriver(config.browserstack, options.capabilities);
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
        // repl.print('… Exporting client …');

        client.exportFile(url, function (err) {
          if (err) {
            console.error('export', err);
            return terminate(1);
          }

          if (wd) {
            repl.print('… Starting session …');
            startWdSession(config, wd, url, terminate);
          }
        });
      });
  });
}


function createTunnel(config) {
  return function (callback) {
    repl.print('… Creating tunnel …');
    debug('Creating tunnel');

    ngrok.connect(config.port, function (err, url) {
      if (url) {
        // repl.print('… ' + url);
        debug('Tunnel ready', url);
      }

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


function initWebDriver(serviceConfig, caps) {
  var capabilities = serviceConfig.getCapabilities(caps);

  // Selenium requires 'browserName'
  capabilities.browserName = capabilities.browser;

  var wd = new webdriver.Builder()
    .usingServer(serviceConfig.hub)
    .withCapabilities(capabilities)
    .build();

  return wd;
}


function startWdSession(config, wd, url, terminate) {
  var wdKeepAliveHandle;

  debug('Opening URL: %s', url);
  wd.get(url);
  repl.print('… Waiting for client connection …');

  wd.wait(function() {
      return wd.getTitle().then(function (title) {
        var isClient = (title === config.client.pageTitle);
        if (isClient) {
          repl.print('… Ready', true);
        }

        return isClient;
      });
    }, config.openTimeout)
    .then(null, function (err) {
      debug('Failed to open URL', err);
      repl.print('Failed to open URL: ' + err);

      terminate(1);
    });

  if (config.keepAliveInterval && config.keepAliveInterval > 0) {
    // repl.print('… Setting up session keep-alive …');

    wd.keepAliveHandle = setInterval(function () {
      wd.executeScript('return 1').then(function(res) {
        debug('Keep-Alive: %s', res);
      }).then(null, function (err) {
        debug('Failed to send/receive keep-alive', err);
        terminate(1);
      });
    }, config.keepAliveInterval);
  }
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
      repl.print('… Terminating session …');
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
    var browsers = browserJsonExists ? require(browserJsonPath) : {};

    if (!browsers || !browsers.length) {
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
        return callback(null, {});
      }

      var browserHash = {};
      browsers.forEach(function (b) {
        browserHash[getBrowserId(b)] = b;
      });

      _([ browserHash ])
        .map(function (obj) {
          return JSON.stringify(obj, null, 2);
        })
        .pipe(fs.createWriteStream(outFile))
        .on('error', callback)
        .on('finish', function () {
          debug('Fin');
          callback(null, browserHash);
        });
    });
}


function getBrowserId(b) {
  var sig;

  if (b.device) {
    sig = [ 'browser', 'device', 'os', 'os_version' ];
  } else {
    sig = [ 'browser', 'browser_version', 'os', 'os_version' ];
  }

  return getBrowserHashKey(sig
    .map(function (k) { return b[k]; })
    .filter(function (b) { return !!b; }));
}


function getBrowserHashKey(c) {
  return (Array.isArray(c) ? c : [])
    .map(function (b) { return keyString(b); })
    .reduce(function (a, b) { return a + '|' + b; });
}


function keyString(s) {
  return s.replace(/\s+/g, '').replace(/\.0$/, '').toLowerCase();
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
