// Uses concepts and code from:
// https://github.com/Automattic/browser-repl/blob/1b7adf204583efeb165726164d3d22d6b25c277b/client.js

window.console = {};
util.each(['log', 'info', 'warn', 'error', 'debug'], function (m) {
  window.console[m] = function () {
    var args = util.map(util.toArray(arguments), function (a) {
      return util.inspect(a, { colors: true });
    });

    primus.write({
      console: {
        method: m,
        arguments: args
      }
    });
  };
});

primus.on('request', function (data, done) {
  if (data && data.request) {
    try {
      var rtn = (function() { return eval.apply(this, arguments); })(data.request);

      done({ response: { result: util.inspect(rtn) } });
    } catch (e) {
      var err = {};
      for (var i in e) err[i] = e[i];
      err.message = e.message;
      err.stack = e.stack;
      err.name = String(e.name);

      done({ response: { error: err } });
    }
  }
});

primus.on('open', function open() {
  document.body.innerHTML = '<h1>Connected.</h1>';
});

primus.on('error', function error(err) {
  document.body.innerHTML = '<h1>Error: ' + err + '</h1>';
});

primus.on('end', function end() {
  document.body.innerHTML = '<h1>Disconnected.</h1>';
});

window.onerror = function (message, url, linenumber){
  primus.write({
    error: {
      message: message,
      url: url,
      line: linenumber
    }
  });
};
