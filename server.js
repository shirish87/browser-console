'use strict';

var _ = require('highland');
var http = require('http');
var serveStatic = require('serve-static');
var finalhandler = require('finalhandler');
var debug = require('diagnostics')('bc:server');

var Primus = require('primus');
var PrimusResponder = require('primus-responder');


module.exports.start = function start(config, replStream, callback) {
  var useCache = !!(config.client && config.client.useCache);

  var indexFile = (useCache ? 'cache.html' : 'index.html');
  debug('Using indexFile: %s', indexFile);

  var serve = serveStatic('public', { 'index': [ indexFile ] });

  var server = http.createServer(function (req, res) {
    serve(req, res, finalhandler(req, res));
  });

  var engine = (
    config &&
    config.websocket &&
    typeof config.websocket.engine === 'string'
    ) ? config.websocket.engine : 'websockets';

  var primus = new Primus(server, { transformer: engine });
  primus.use('responder', PrimusResponder);

  var dataStream = createDataStream(primus, replStream);

  server.listen(config.port, function (err) {
    callback(err, primus, dataStream);
  });
};


function createDataStream(primus, replStream) {
  return _(function (push) {
    var connStream = _('connection', primus).take(1);

    var isTerminated = false;

    var terminate = function terminate(spark) {
      if (!isTerminated) {
        debug('primus-terminate');
        isTerminated = true;
        connStream.destroy();

        if (spark.replStream) {
          try {
            spark.replStream.destroy();
          } catch (e) {
            // the REPL may have been destroyed already
          }
        }

        spark.end();
        primus.destroy();
        push(null, _.nil);
      }
    };

    primus.on('disconnection', terminate);

    connStream.toArray(function (sparks) {
      var spark = sparks.shift();
      debug('spark-connected: %s', spark.id);

      spark.replStream = replStream.fork()
        .each(function (inp) {

          spark.writeAndWait({ request: inp.data }, function (res) {
            if (typeof res === 'object') {
              if (res.error) {
                // window.onerror
                inp.print(res.error);
              } else if (res.response) {
                inp.print(res.response.error, res.response.result);
              }
            }
          });

        }).done(function () {
          terminate(spark);
        });

      spark.on('data', function (data) {
        debug('spark-data', data);
        push(null, data);
      });

      spark.on('end', function (data) {
        debug('spark-end');
        terminate(spark);
      });

    });

  });
}
