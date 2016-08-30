import electron from 'electron';
import {some} from 'lodash';
import {requireTaskPool} from 'electron-remote';
import {Disposable, CompositeDisposable, SerialDisposable} from 'rx-lite';
import {regExpReviver, formatReplacement} from './regular-expressions';
import {isUndoRedoEvent} from './undo-redo-event';

const createReplacementItems = requireTaskPool(require.resolve('./create-replacement-items'));

const packageName = 'electron-text-substitutions';
const d = require('debug-electron')(packageName);

const userDefaultsTextSubstitutionsKey = 'NSUserDictionaryReplacementItems';
const userDefaultsSmartQuotesKey = 'NSAutomaticQuoteSubstitutionEnabled';
const userDefaultsSmartDashesKey = 'NSAutomaticDashSubstitutionEnabled';

const textPreferenceChangedKeys = [
  'IMKTextReplacementDidChangeNotification',
  'NSAutomaticQuoteSubstitutionEnabledChanged',
  'NSAutomaticDashSubstitutionEnabledChanged'
];

let systemPreferences, replacementItems;

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
export default async function performTextSubstitution(element, preferenceOverrides = null) {
  if (!element || !element.addEventListener) throw new Error(`Element is null or not an EventTarget`);
  if (!process || !process.type === 'renderer') throw new Error(`Not in an Electron renderer context`);
  if (process.platform !== 'darwin') throw new Error(`Only supported on OS X`);

  systemPreferences = systemPreferences || electron.remote.systemPreferences;

  if (!systemPreferences || !systemPreferences.getUserDefault) {
    throw new Error(`Electron ${process.versions.electron} is not supported`);
  }

  let currentAttach = await assignDisposableToListener(element, preferenceOverrides);
  let subscriptionIds = [];

  // TODO: It'd be much more efficient to only subscribe these once, rather
  // than for each input element.
  for (let preferenceChangedKey of textPreferenceChangedKeys) {
    subscriptionIds.push(systemPreferences.subscribeNotification(preferenceChangedKey, async function() {
      replacementItems = null;
      d(`User modified ${preferenceChangedKey}, reattaching listener`);
      await assignDisposableToListener(element, preferenceOverrides, currentAttach);
    }));
  }

  let changeHandlerDisposable = new Disposable(() => {
    for (let subscriptionId of subscriptionIds) {
      systemPreferences.unsubscribeNotification(subscriptionId);
    }
    d(`Cleaned up all listeners`);
  });

  let combinedDisposable = new CompositeDisposable(currentAttach, changeHandlerDisposable);

  window.addEventListener('beforeunload', () => {
    combinedDisposable.dispose();
  });

  return combinedDisposable;
}

async function assignDisposableToListener(element, preferenceOverrides, currentAttach = null) {
  if (preferenceOverrides) {
    replacementItems = JSON.parse(await createReplacementItems(preferenceOverrides), regExpReviver);
  } else if (!replacementItems) {
    replacementItems = JSON.parse(await createReplacementItems(readSystemTextPreferences()), regExpReviver);
  }

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
    if (isUndoRedoEvent(e)) {
      d(`Undo or redo text from ${e.target.value}`);
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
