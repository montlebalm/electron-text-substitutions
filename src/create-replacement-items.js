import {getSubstitutionRegExp, getSmartQuotesRegExp, getSmartDashesRegExp,
  scrubInputString, regExpReplacer} from './regular-expressions';

const packageName = 'electron-text-substitutions';
const d = require('debug-electron')(packageName);

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
module.exports = function createReplacementItems({substitutions, useSmartQuotes, useSmartDashes}) {
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
  let startTime = Date.now();
  let userDictionaryReplacements = substitutions
    .filter((substitution) => substitution.on !== false)
    .sort((a, b) => b.replace.length - a.replace.length)
    .map((substitution) => getSubstitutionRegExp(substitution.replace,
      scrubInputString(substitution.with, additionalReplacements)));

  let elapsed = Date.now() - startTime;
  d(`Spent ${elapsed} ms in createReplacementItems`);

  return JSON.stringify([
    ...userDictionaryReplacements,
    ...additionalReplacements
  ], regExpReplacer);
};
