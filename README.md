# electron-text-substitutions

Are you…
  - [x] Using Electron?
  - [x] Making a Mac app?
  - [x] And want it to respect your macOS text substitutions?

Then this is :sparkles: **FOR YOU.** :sparkles:

![](https://s3.amazonaws.com/f.cl.ly/items/1l1Y1V0F042r2C0L1e20/Image%202016-06-06%20at%207.28.44%20PM.png?v=6aa3150f)

## Install

```
npm i electron-text-substitutions --save
```

Electron ≥[v1.2.2](https://github.com/electron/electron/releases/tag/v1.2.2) is required for this to work.

## Use

``` js
import performTextSubstitution from 'electron-text-substitutions';

let input = document.getElementById('my-input');
performTextSubstitution(input);
```

We use the [`system-preferences`](http://electron.atom.io/docs/api/system-preferences/#systempreferences) API to get the user's text substitutions. If you have smart quotes or dashes enabled, we'll handle that too.

#### Change notifications

To receive text preference change notifications, you'll need to call an additional method, that only works in the main process. This should be called before any renderer starts using text substitutions.

``` js
import {listenForPreferenceChanges} from 'electron-text-substitutions';
listenForPreferenceChanges();
```

## API

#### Renderer Process

``` js
/**
 * Adds an `input` event listener to the given element (an <input> or
 * <textarea>) that will substitute text based on the user's replacements in
 * `NSUserDefaults`, as well as smart quotes and dashes.
 *
 * @param  {EventTarget} element  The DOM node to listen to; should fire the `input` event
 * @return {Disposable}           A `Disposable` that will clean up everything this method did
 */
performTextSubstitution(element);
```

#### Main Process

``` js
/**
 * Subscribes to text preference changed notifications and notifies listeners
 * in renderer processes. This method must be called from the main process, and
 * should be called before any renderer process calls `performTextSubstitution`.
 *
 * @return {Disposable}  A `Disposable` that will clean up everything this method did
 */
listenForPreferenceChanges() {
```
