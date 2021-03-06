import electron from 'electron';
import {forEach, values, some} from 'lodash';
import {Observable, Disposable, CompositeDisposable, SerialDisposable} from 'rx-lite';
import {getSubstitutionRegExp, getSmartQuotesRegExp, getSmartDashesRegExp,
  scrubInputString, formatReplacement, regExpReplacer, regExpReviver} from './regular-expressions';
import {isUndoRedoEvent, isBackspaceEvent} from './keyboard-utils';

const packageName = 'electron-text-substitutions';
const d = require('debug-electron')(packageName);

const registerForPreferenceChangedIpcMessage = `${packageName}-register-renderer`;
const unregisterForPreferenceChangedIpcMessage = `${packageName}-unregister-renderer`;
const preferenceChangedIpcMessage = `${packageName}-preference-changed`;

const userDefaultsTextSubstitutionsKey = 'NSUserDictionaryReplacementItems';
const userDefaultsSmartQuotesKey = 'NSAutomaticQuoteSubstitutionEnabled';
const userDefaultsSmartDashesKey = 'NSAutomaticDashSubstitutionEnabled';

const textPreferenceChangedKeys = [
  'IMKTextReplacementDidChangeNotification',
  'NSAutomaticQuoteSubstitutionEnabledChanged',
  'NSAutomaticDashSubstitutionEnabledChanged'
];

let ipcMain, ipcRenderer, systemPreferences;
let replacementItems = null;
let registeredWebContents = {};

/**
 * Adds an `input` event listener to the given element (an <input> or
 * <textarea>) that will substitute text based on the user's replacements in
 * `NSUserDefaults`.
 *
 * In addition, this method will listen for changes to `NSUserDefaults` and
 * update accordingly.
 *
 * @param  {EventTarget} element          The DOM node to listen to; should fire the `input` event
 * @param  {Object} preferenceOverrides   Used to override text preferences in testing
 *
 * @return {Disposable}                   A `Disposable` that will clean up everything this method did
 */
export default function performTextSubstitution(element, preferenceOverrides = null) {
  if (!element || !element.addEventListener) throw new Error(`Element is null or not an EventTarget`);
  if (!process || !process.type === 'renderer') throw new Error(`Not in an Electron renderer context`);
  if (process.platform !== 'darwin') throw new Error(`Only supported on OS X`);

  ipcRenderer = ipcRenderer || electron.ipcRenderer;
  systemPreferences = systemPreferences || electron.remote.systemPreferences;

  if (!systemPreferences || !systemPreferences.getUserDefault) {
    throw new Error(`Electron ${process.versions.electron} is not supported`);
  }

  ipcRenderer.send(registerForPreferenceChangedIpcMessage);

  window.addEventListener('beforeunload', () => {
    d(`Window unloading, unregister any listeners`);
    ipcRenderer.send(unregisterForPreferenceChangedIpcMessage);
  });

  if (preferenceOverrides) {
    replacementItems = getReplacementItems(preferenceOverrides);
  } else if (!replacementItems) {
    replacementItems = getReplacementItems(readSystemTextPreferences());
  }

  let currentAttach = assignDisposableToListener(element, replacementItems);

  ipcRenderer.on(preferenceChangedIpcMessage, (e, serializedItems) => {
    d(`User modified text preferences, reattaching listener`);
    replacementItems = JSON.parse(serializedItems, regExpReviver);
    assignDisposableToListener(element, replacementItems, currentAttach);
  });

  return currentAttach;
}

/**
 * Subscribes to text preference changed notifications and notifies listeners
 * in renderer processes. This method must be called from the main process, and
 * should be called before any renderer process calls `performTextSubstitution`.
 *
 * @return {Disposable}  A `Disposable` that will clean up everything this method did
 */
export function listenForPreferenceChanges() {
  if (!process || !process.type === 'browser') throw new Error(`Not in an Electron browser context`);
  if (process.platform !== 'darwin') throw new Error(`Only supported on OS X`);

  ipcMain = ipcMain || electron.ipcMain;
  systemPreferences = systemPreferences || electron.systemPreferences;

  ipcMain.on(registerForPreferenceChangedIpcMessage, ({sender}) => {
    let id = sender.getId();
    d(`Registering webContents ${id} for preference changes`);
    registeredWebContents[id] = { id, sender };
  });

  ipcMain.on(unregisterForPreferenceChangedIpcMessage, ({sender}) => {
    d(`Unregistering webContents ${sender.getId()}`);
    delete registeredWebContents[sender.getId()];
  });

  let notificationDisp = Observable.fromArray(textPreferenceChangedKeys)
    .flatMap((key) => observableForPreferenceNotification(key))
    .debounce(1000)
    .subscribe(notifyAllListeners);

  return new CompositeDisposable(
    notificationDisp,
    new Disposable(() => ipcMain.removeAllListeners(registerForPreferenceChangedIpcMessage)),
    new Disposable(() => ipcMain.removeAllListeners(unregisterForPreferenceChangedIpcMessage))
  );
}

/**
 * Creates an Observable that will `onNext` when the given key in
 * `NSUserDefaults` changes.
 *
 * @param  {String} preferenceChangedKey  The key to listen for
 * @return {Disposable}                   A Disposable that will unsubscribe the listener
 */
function observableForPreferenceNotification(preferenceChangedKey) {
  return Observable.create((subj) => {
    let subscriberId = systemPreferences.subscribeNotification(preferenceChangedKey, () => {
      d(`Got a ${preferenceChangedKey}`);
      subj.onNext(preferenceChangedKey);
    });

    return new Disposable(() => systemPreferences.unsubscribeNotification(subscriberId));
  });
}

/**
 * Sends an IPC message to each `WebContents` that is doing text substitution,
 * unless it has been destroyed, in which case remove it from our list.
 */
function notifyAllListeners() {
  let textPreferences = readSystemTextPreferences();
  let replacementItems = getReplacementItems(textPreferences);
  let serializedItems = JSON.stringify(replacementItems, regExpReplacer);

  forEach(values(registeredWebContents), ({id, sender}) => {
    if (sender.isDestroyed() || sender.isCrashed()) {
      d(`WebContents ${id} is gone, removing it`);
      delete registeredWebContents[id];
    } else {
      sender.send(preferenceChangedIpcMessage, serializedItems);
    }
  });
}

function assignDisposableToListener(element, replacementItems, currentAttach = null) {
  currentAttach = currentAttach || new SerialDisposable();
  currentAttach.setDisposable(addInputListener(element, replacementItems));
  return currentAttach;
}

function readSystemTextPreferences() {
  return {
    substitutions: systemPreferences.getUserDefault(userDefaultsTextSubstitutionsKey, 'array') || [],
    useSmartQuotes: systemPreferences.getUserDefault(userDefaultsSmartQuotesKey, 'boolean'),
    useSmartDashes: systemPreferences.getUserDefault(userDefaultsSmartDashesKey, 'boolean')
  };
}

/**
 * @typedef {Object} TextSubstitution
 * @property {String} replace The text to replace
 * @property {String} with    The replacement text
 * @property {Bool}   on      True if this substitution is enabled
 */

 /**
  * Creates a regular expression for each text substitution entry, in addition
  * to expressions for smart quotes and dashes (if they're enabled).
  *
  * @param  {Array<TextSubstitution>} {substitutions  An array of text substitution entries
  * @param  {Bool} useSmartQuotes                     True if smart quotes is on
  * @param  {Bool} useSmartDashes}                    True if smart dashes is on
  * @return {Array<ReplacementItem>}                  An array of replacement items
  */
function getReplacementItems({substitutions, useSmartQuotes, useSmartDashes}) {
  d(`Smart quotes are ${useSmartQuotes ? 'on' : 'off'}`);
  d(`Smart dashes are ${useSmartDashes ? 'on' : 'off'}`);

  let additionalReplacements = [
    ...(useSmartQuotes ? getSmartQuotesRegExp() : []),
    ...(useSmartDashes ? getSmartDashesRegExp() : [])
  ];

  d(`Found ${substitutions.length} substitutions in NSUserDictionaryReplacementItems`);

  // NB: Run each replacement string through our smart quotes & dashes regex,
  // so that an input event doesn't cause chained substitutions. Also sort
  // replacements by length, to handle nested substitutions.
  let userDictionaryReplacements = substitutions
    .filter((substitution) => substitution.on !== false)
    .sort((a, b) => b.replace.length - a.replace.length)
    .map((substitution) => getSubstitutionRegExp(substitution.replace,
      scrubInputString(substitution.with, additionalReplacements)));

  return [
    ...userDictionaryReplacements,
    ...additionalReplacements
  ];
}

/**
 * Subscribes to the `input` event and performs text substitution.
 *
 * @param  {EventTarget} element                      The DOM node to listen to
 * @param  {Array<ReplacementItem>} replacementItems  An array of replacement items
 * @return {Disposable}                               A `Disposable` that will remove the listener
 */
function addInputListener(element, replacementItems) {
  let ignoreEvent = false;

  let inputListener = () => {
    if (ignoreEvent) return;
    ignoreEvent = true;

    for (let {regExp, replacement} of replacementItems) {
      // Rather than search the entire input, we're just going to check the word
      // immediately before the caret (along with its surrounding whitespace).
      // This is to avoid substitutions after, say, a paste or an undo.
      let searchStartIndex = lastIndexOfWhitespace(element.value, element.selectionEnd);
      let lastWordBlock = element.value.substring(searchStartIndex, element.selectionEnd);
      let match = lastWordBlock.match(regExp);

      if (match && match.length === 3) {
        d(`Got a match of length ${match[0].length} at index ${match.index}: ${JSON.stringify(match)}`);

        if (some(replacementItems, (item) => item.match === match[0])) {
          d(`The match is a prefix of another replacement item (${match[0]}), skip it`);
          continue;
        }

        let selection = {
          startIndex: searchStartIndex + match.index,
          endIndex: searchStartIndex + match.index + match[0].length
        };

        replaceText(element, selection, formatReplacement(match, replacement));
      }
    }

    ignoreEvent = false;
  };

  let keyDownListener = (e) => {
    if (isUndoRedoEvent(e) || isBackspaceEvent(e)) {
      d(`Ignoring keydown event from ${e.target.value}`);
      ignoreEvent = true;
    }
  };

  let pasteListener = () => {
    ignoreEvent = true;
  };

  let keyUpListener = () => {
    ignoreEvent = false;
  };

  element.addEventListener('keydown', keyDownListener, true);
  element.addEventListener('paste', pasteListener, true);
  element.addEventListener('keyup', keyUpListener, true);
  element.addEventListener('input', inputListener);

  d(`Added input listener to ${element.id} matching against ${replacementItems.length} replacements`);

  return new Disposable(() => {
    element.removeEventListener('keydown', keyDownListener);
    element.removeEventListener('paste', pasteListener);
    element.removeEventListener('keyup', keyUpListener);
    element.removeEventListener('input', inputListener);

    d(`Removed input listener from ${element.id}`);
  });
}

function lastIndexOfWhitespace(value, fromIndex) {
  let lastIndex = 0;
  let whitespace = /\s/g;
  let textToCaret = value.substring(0, fromIndex).trimRight();

  while (whitespace.exec(textToCaret) !== null) {
    lastIndex = whitespace.lastIndex;
  }
  return lastIndex;
}

/**
 * Performs the actual text replacement using `dispatchEvent`. We use events to
 * preserve the user's cursor index and make the substitution undoable.
 *
 * @param  {EventTarget} element  The DOM node where text is being substituted
 * @param  {Number} {startIndex   Start index of the text to replace
 * @param  {Number} endIndex}     End index of the text to replace
 * @param  {String} newText       The text being inserted
 */
function replaceText(element, {startIndex, endIndex}, newText) {
  let textEvent = document.createEvent('TextEvent');
  textEvent.initTextEvent('textInput', true, true, null, newText);

  element.selectionStart = startIndex;
  element.selectionEnd = endIndex;

  d(`Replacing ${element.value.substring(startIndex, endIndex)} with ${newText}`);
  element.dispatchEvent(textEvent);
}
