# browser-console
Creates a session with a browser of your choice running on the [BrowserStack Automate](http://www.browserstack.com/automate) platform and allows you to run JavaScript code and receive the output in your local shell.

Although written from scratch, this tool uses concepts and code from the excellent [browser-repl](https://github.com/Automattic/browser-repl) module.

There are plans to make this module platform agnostic so it could be used with any Selenium-based cloud/internal/local service. Feedback and PR's welcome. :)

**Note**: This is a work-in-progress at the moment and is only intended for early testers.

## Requirements
This module currently requires you to have a [BrowserStack Automate](http://www.browserstack.com/automate) account. Once created, please set the following environment variables for your shell.
```
BROWSERSTACK_USERNAME=<your-username>
BROWSERSTACK_KEY=<your-access-key>
```

## Install
Use the following command to install this module globally and make the `browser-console` command available in your shell.
```
$ npm install -g browser-console
```

## Usage
```
$ browser-console <browser>-<browser-version> <os>-<os-version>
```
Please refer to this [list of supported browsers and OSs](https://www.browserstack.com/list-of-browsers-and-platforms?product=automate).

Example:
```
$ browser-console firefox-35 windows-7
```
Once your session is initialized and you receive `Ready`, you may begin typing in any JavaScript code you wish to execute in the remote browser.

```
$ browser-console chrome-42 windows-7
… Loading …
… Starting server …
… Creating tunnel …
… Starting session …
… Waiting for client connection …
… Ready
 › typeof window
'object'
 › typeof Promise
'function'
 › typeof Proxy
'undefined'
 › var f = function func() { console.log('i am func'); }
undefined
 › f.name
'func'
 › let test = 'template'
SyntaxError: Block-scoped declarations (let, const, function, class) not yet supported outside strict mode
...
 › var test = 'template'
undefined
 › console.log(`${test} strings`)
'template strings'
```

## Known Issues
* Functions that create browser dialog boxes such as `alert()` hang the session
* Usability and messaging could use some improvement
