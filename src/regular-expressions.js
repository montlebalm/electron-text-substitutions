import {escapeRegExp, reduce} from 'lodash';

export const openingSingleQuote = '\u2018'; // ‘
export const closingSingleQuote = '\u2019'; // ’

export const openingDoubleQuote = '\u201c'; // “
export const closingDoubleQuote = '\u201d'; // ”

export const emDash   = '\u2014';           // —
export const ellipsis = '\u2026';           // …

/**
 * Recreate something like \b; we don't want to use \b because no Unicode support.
 */
const wordBoundary = /[ \n\r\t.,|{}()<>'"`+!?«»“”‘’‹›—–−-]/;
const startsWithWordBoundary = new RegExp(`^${wordBoundary.source}`);

/**
 * @typedef {Object} ReplacementItem
 * @property {String} regExp       A regular expression that matches the text to replace
 * @property {String} replacement  The replacement text
 */

/**
 * Creates a regular expression that will match a word and its boundaries– that
 * is, some surrounding whitespace or separator character.
 *
 * @param  {String} match     The string to match
 * @return {ReplacementItem}  A replacement item; contains a `RegExp` and its replacement
 */
export function getSubstitutionRegExp(match, replacement) {

  // Require the start of input or a word boundary, unless the string to match
  // starts with a boundary (e.g., `(tm)`) in which case we want to match text
  // like `BigCompany(tm)`.
  let startOfInputOrBoundary = startsWithWordBoundary.test(match) ?
    '' :
    `^\|${wordBoundary.source}`;

  // Capture the left and right boundaries as groups $1 and $2, to align with
  // `formatReplacement`. Be sure to escape special characters in the string
  // to match.
  let regExp = new RegExp(
    `(${startOfInputOrBoundary})` +
    `${escapeRegExp(match)}` +
    `(${wordBoundary.source})`
  , 'u');

  return { regExp, replacement };
}

/**
 * Returns an array of regular expressions that will progressively replace
 * straight quotes with curly quotes.
 *
 * @return {Array<ReplacementItem>}  An array of replacement items
 */
export function getSmartQuotesRegExp() {
  return [
    { regExp: /(\S)"([\S\s])/u, replacement: closingDoubleQuote },
    { regExp: /()"([\S\s])/u, replacement: openingDoubleQuote },
    { regExp: /([\S\s])'(\W)/u, replacement: closingSingleQuote },
    { regExp: /(\W|^)'([\w\s])/u, replacement: openingSingleQuote },
    { regExp: /(\w)'(\w+\W)/u, replacement: closingSingleQuote }
  ];
}

/**
 * Returns an array of regular expressions that will replace hypens with
 * em-dashes (and ellipsis, as a bonus).
 *
 * @return {Array<ReplacementItem>}  An array of replacement items
 */
export function getSmartDashesRegExp() {
  return [
    { regExp: /(^|[^-])---([^-])/u, replacement: emDash },
    { regExp: /(^|[^-])--([^-])/u, replacement: emDash },
    { regExp: /(^|[^.])\.\.\.([^.])/u, replacement: ellipsis }
  ];
}

/**
 * Replaces text in an input string using the given replacement items.
 *
 * @param  {String} input                 The input string
 * @param  {Array<ReplacementItem>} items An array of replacement items
 * @return {String}                       The output string
 */
export function scrubInputString(input, items) {
  return reduce(items, (output, {regExp, replacement}) =>
    output.replace(regExp, `$1${replacement}$2`), input);
}

/**
 * Preserves whitespace around the match. These expressions match the text
 * being substituted along with boundaries on the left ($1) and right ($2).
 */
export function formatReplacement(match, replacement) {
  let [, left, right] = match;
  return `${left}${replacement}${right}`;
}
