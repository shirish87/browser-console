'use strict';

var inspect = require('util-inspect');
var map = require('array-map');
var each = require('foreach');
var toArray = require('to-array');


global.util = {
  map: map,
  each: each,
  toArray: toArray
};

/**
* Provides util.inspect like features for the browser.
* Helps get around JSON.stringify issues with circular refs and such.
*/
global.util.inspect = function (data) {
  return inspect(data, { colors: true });
};
