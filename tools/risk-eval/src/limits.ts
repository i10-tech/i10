/**
 * Every bound applied to untrusted input in one place. The datasets are real
 * phishing and spam, so each parser fails closed at these numbers instead of
 * trusting what a file says about itself.
 */

/** Characters of text and html kept per mail; the rest is cut. */
export const MAX_TEXT_CHARS = 100_000
export const MAX_HTML_CHARS = 200_000

/** Bytes of one raw message handed to the MIME parser; the rest is cut. */
export const MAX_RAW_MESSAGE_BYTES = 4 * 1024 * 1024

/** One downloaded file, and one file read whole into memory. */
export const MAX_FILE_BYTES = 600 * 1024 * 1024

/** Archive extraction. */
export const MAX_ARCHIVE_ENTRIES = 200_000
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024

/** MIME nesting depth and total parts walked per message. */
export const MAX_MIME_DEPTH = 8
export const MAX_MIME_PARTS = 200

/** Mails shorter than this after whitespace normalisation are dropped. */
export const MIN_NORMALISED_CHARS = 20
