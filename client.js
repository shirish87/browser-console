'use strict';

var fs = require('fs');
var path = require('path');
var uglify = require('uglify-js');
var _ = require('highland');
var debug = require('diagnostics')('bc:client');


var pageTitle = 'browser-console';

var pageHeader = [
  '<!DOCTYPE html>',
  '<html>',
  '<head>',
  '  <title>' + pageTitle + '</title>',
  '</head>',
  '<body>',
  '<script>'
].join('\n');

var pageFooter = [
  '</script>',
  '</body>',
  '</html>'
].join('\n');


var connectCode = 'var primus = Primus.connect();';


function Client(config, primus) {
  this._config = config.client || {};
  this._primus = primus;

  this._path = this._config.path || 'public';
  this._useCache = !!this._config.useCache;

  this._mainHtml = this._config.mainHtml || 'index.html';
  this._cacheHtml = this._config.cacheHtml || 'cache.html';

  this._mainHtmlPath = this.getFilePath(this._mainHtml);
  this._cacheHtmlPath = this.getFilePath(this._cacheHtml);

  this._clientJs = this._config.clientJs || 'client.js';
  this._utilJs = this._config.utilJs || 'util.js';

  this._cacheExists = false;
  this._clientStream = null;

  this._dynamicCode = [];
}

Client.prototype.getFilePath = function getFilePath(f) {
  return path.join(__dirname, this._path, f);
};

Client.prototype.build = function build(callback) {
  var that = this;
  var readFile = _.wrapCallback(fs.readFile);

  // None of these actions are actually executed
  // until something comes along to 'thunk' it

  this._clientStream = _(function (push) {
      push(null, that._primus.library());
      push(null, _.nil);
    })
    .concat(_(readFile(this.getFilePath(this._utilJs))))
    .concat(_(function (push) {
      // we create a stream here so that dynamic code could be modified later

      var dynCode = that._dynamicCode;
      dynCode = (!dynCode || !dynCode.length) ? [ connectCode ] : dynCode;

      dynCode.forEach(function (c) {
        push(null, c);
      });

      push(null, _.nil);
    }))
    .concat(_(readFile(this.getFilePath(this._clientJs))))
    .reduce1(function (a, b) { return a + b; })
    .flatMap(this.uglifyStream)
    .map(function (js) {
      var head = that.config.pageTitle ?
        pageHeader.replace(pageTitle, that.config.pageTitle) : pageHeader;

      return head + js + pageFooter;
    });

  process.nextTick(function () {
    callback(null, that);
  });
};


Client.prototype.exportFile = function exportFile(tunnelUrl, callback) {
  var that = this;
  debug('Exporting client html.');

  var useCache = !!this._config.useCache;
  if (!useCache) {
    debug('Cache disabled. Exporting to mainHtml.');
    return this._export(this._mainHtmlPath, tunnelUrl, callback);
  }

  this.cacheExists(function (err, cacheExists) {
    if (cacheExists) {
      debug('Cache exists.');
      return callback(err, that);
    }

    that._export(that._cacheHtmlPath, null, function (err) {
      debug('Cache replenished.');
      return callback(err, that);
    });
  });
};


Client.prototype.cacheExists = function (callback) {
  fs.stat(this._cacheHtmlPath, function (err, stats) {
    return callback(err, (stats && stats.isFile()));
  });
};


Client.prototype._copyCacheToMain = function (callback) {
  callback = this._callbackOnce(callback);

  var rd = fs.createReadStream(this._cacheHtmlPath);
  rd.on('error', callback);

  var wr = fs.createWriteStream(this._mainHtmlPath);
  wr.on('error', callback);
  wr.on('finish', callback);
  rd.pipe(wr);
};


Client.prototype._callbackOnce = function (callback) {
  var that = this;

  return function (err) {
    if (callback) {
      var cb = callback;
      callback = null;
      cb(err, that);
    }
  };
};


Client.prototype._export = function _export(path, tunnelUrl, callback) {
  if (!this._clientStream) {
    return callback(new Error('client.build()?'));
  }

  var that = this;
  var callbackOnce = this._callbackOnce(callback);

  var destStream = fs.createWriteStream(path);
  destStream.on('error', function (err) {
    callbackOnce(err);
  });

  var connCode = !tunnelUrl ? connectCode : connectCode.replace('connect()', 'connect("' + tunnelUrl + '")');

  this._dynamicCode.unshift(connCode);

  this._clientStream
    .errors(function (err, push) {
      push(null, {}); // pass err to cb, suppress errors in the stream
      callbackOnce(err);
    })
    .pipe(destStream)
    .on('finish', function () {
      callbackOnce(null);
    });
};

Client.prototype.uglifyStream = function uglifyStream(code) {
  return _(function (push) {
    var res = uglify.minify(code, { fromString: true });
    if (!res || !res.code) {
      return push(new Error('Failed to uglify client.'));
    }

    push(null, res.code);
    push(null, _.nil);
  });
};


module.exports = Client;
