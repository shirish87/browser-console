'use strict';

var repl = require('repl');
var _ = require('highland');
var rl = require('readline');


var isAnsiReadlineOK = 'stripVTControlCharacters' in rl;
var promptText = isAnsiReadlineOK ? '\x1b[96m › \x1b[39m' : ' › ';

var replServer;
var isPromptSet = false;


module.exports.print = function (msg, withPrompt) {
  rl.clearLine(process.stdout, 0);
  console.log(msg || '');

  if (withPrompt) {
    this.showPrompt();
  }
};

module.exports.showPrompt = function () {
  if (replServer) {
    if (!isPromptSet) {
      replServer.setPrompt(promptText);
    }

    replServer.prompt();
  }
};

module.exports.start = function start(config) {
  var that = this;

  return _(function (push, next) {

    replServer = repl.start({
      prompt: '',
      eval: function (cmd, ctx, file, fn) {
        var hasData = (cmd && !!cmd.trim());
        if (!hasData) {
          return that.showPrompt();
        }

        // the REPL doesn't go back to 'prompt mode' until `fn` is called, so we
        // keep it around as `print` for the response from the client to use.

        push(null, {
          data: cmd,
          print: function (err, res) {
            var data = err ? formatError(err) : formatData(res);
            fn(data);
          }
        });
      }
    });

    replServer.on('exit', function () {
      try {
        push(null, _.nil);
      } catch (e) {
        // consumers may have already been destroyed
      }
    });

  });
};


function formatData(data) {
  return (typeof data === 'object') ? JSON.stringify(data) : data;
}

function formatError(err) {
  // Credit: https://github.com/Automattic/browser-repl/blob/1b7adf204583efeb165726164d3d22d6b25c277b/repl.js#L161

  // we have to create a synthetic SyntaxError if one occurred in the
  // browser because the REPL special-cases that error
  // to display the "more" prompt
  if (
    // most browsers set the `name` to "SyntaxError"
    ('SyntaxError' === err.name &&
      // firefox
      ('syntax error' === err.message ||
       'function statement requires a name' === err.message ||
      // iOS
       'Parse error' === err.message ||
      // opera
       /syntax error$/.test(err.message) ||
       /expected (.*), got (.*)$/.test(err.message) ||
      // safari
       /^Unexpected token (.*)$/.test(err.message)
      )
    ) ||
    // old IE doens't even have a "name" property :\
    ('Syntax error' === err.message || /^expected /i.test(err.message))
  ) {
    err = new SyntaxError('Unexpected end of input');
  } else {
    // any other `err` needs to be converted to an `Error` object
    // with the given `err`s properties copied over
    var e = new Error();

    // force an empty stack trace on the server-side... in the case where
    // the client-side didn't send us a `stack` property (old IE, safari),
    // it's confusing to see a server-side stack trace.
    e.stack = '';

    for (var i in err) {
      e[i] = err[i];
    }

    // firefox and opera, in particular, doesn't include the "name"
    // or "message" in the stack trace
    var prefix = e.name;
    if (e.message) prefix += ': ' + e.message;
    if (e.stack.substring(0, prefix.length) !== prefix) {
      e.stack = prefix + '\n' + e.stack;
    }

    err = e;
  }

  return err;
}
