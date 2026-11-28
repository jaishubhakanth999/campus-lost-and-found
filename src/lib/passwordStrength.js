'use strict';

/**
 * Password strength — one scoring function, used by the server to *enforce* the
 * policy and mirrored in public/assets/api.js to *show* it.
 *
 * The two copies are kept in step by tests/password.test.js, which loads the
 * browser file and asserts it returns the same score for the same input.
 *
 * Deliberately not zxcvbn: no dependency, no 800 KB dictionary, and the rules
 * are ones a student can be told in one sentence. Score 0–4:
 *
 *   0 very weak · 1 weak · 2 fair · 3 strong · 4 very strong
 *
 * Length is the dominant factor because it is the only one that reliably adds
 * entropy; character variety adds a little; known-bad patterns subtract.
 */

const COMMON = [
  'password', 'passw0rd', 'qwerty', 'qwertyuiop', 'azerty', 'letmein', 'welcome',
  'iloveyou', 'admin', 'administrator', 'root', 'toor', 'abc123', 'abcd1234',
  '123456', '1234567', '12345678', '123456789', '1234567890', '111111', '000000',
  'monkey', 'dragon', 'sunshine', 'princess', 'football', 'cricket', 'india123',
  'campus', 'campusconnect', 'student', 'college', 'university', 'saiuniversity',
  'changeme', 'secret', 'master', 'superman', 'batman', 'trustno1', 'whatever',
];

const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

function classesOf(value) {
  return {
    lower: /[a-z]/.test(value),
    upper: /[A-Z]/.test(value),
    digit: /[0-9]/.test(value),
    symbol: /[^A-Za-z0-9]/.test(value),
  };
}

function hasRun(value) {
  // three or more identical characters, e.g. "aaa"
  if (/(.)\1\1/.test(value)) return true;
  // four or more ascending/descending characters from a keyboard or alphabet run
  const lower = value.toLowerCase();
  for (const seq of SEQUENCES) {
    for (let i = 0; i + 4 <= seq.length; i += 1) {
      const chunk = seq.slice(i, i + 4);
      if (lower.includes(chunk) || lower.includes([...chunk].reverse().join(''))) return true;
    }
  }
  return false;
}

function strength(value) {
  const pw = String(value == null ? '' : value);
  const hints = [];
  const classes = classesOf(pw);
  const variety = Object.values(classes).filter(Boolean).length;

  if (!pw) {
    return { score: 0, label: 'Very weak', hints: ['Enter a password'] };
  }

  const lower = pw.toLowerCase();
  // Exact match, or a common word with only digits/symbols appended ("password123"),
  // is fatal. A common word buried in a longer passphrase only caps the score —
  // and a genuinely long passphrase is not capped at all.
  const lettersOnly = lower.replace(/[^a-z]/g, '');
  const isCommon = COMMON.some((word) => lower === word || lettersOnly === word);
  const containsCommon = COMMON.some((word) => word.length >= 5 && lower.includes(word));
  const isRun = hasRun(pw);
  const onlyDigits = /^[0-9]+$/.test(pw);

  let score;
  if (pw.length < 8) score = 0;
  else if (pw.length < 12) score = 1;
  else if (pw.length < 16) score = 2;
  else score = 3;

  if (variety >= 3) score += 1;
  if (variety === 4) score += 1;

  if (isCommon) score = Math.min(score, 0);
  else if (containsCommon && pw.length < 16) score = Math.min(score, pw.length < 12 ? 1 : 2);
  if (onlyDigits) score = Math.min(score, 0);
  if (isRun) score -= 1;
  if (pw.length >= 20) score += 1;

  score = Math.max(0, Math.min(4, score));

  // Hints are ordered by how much each one would help.
  if (pw.length < 8) hints.push('Use at least 8 characters');
  else if (pw.length < 12) hints.push('Longer is stronger — 12 or more characters');
  if (variety < 3) hints.push('Mix upper case, lower case and numbers');
  if (!classes.symbol) hints.push('A symbol makes it much harder to guess');
  if (isCommon || containsCommon) hints.push('Avoid common words like “password”, “campus” or your name');
  if (onlyDigits) hints.push('Digits alone are guessed almost instantly');
  if (isRun) hints.push('Avoid repeated characters and sequences like “abc” or “1234”');

  const labels = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
  return { score, label: labels[score], hints: hints.slice(0, 3) };
}

/** The floor the server enforces for a given role. */
const MIN_SCORE = { student: 2, admin: 3 };

function meetsPolicy(password, role = 'student') {
  const result = strength(password);
  const floor = MIN_SCORE[role] || MIN_SCORE.student;
  const minLength = role === 'admin' ? 12 : 8;
  const ok = result.score >= floor && String(password).length >= minLength;
  return {
    ok,
    ...result,
    message: ok
      ? null
      : `That password is too easy to guess. ${result.hints[0] || 'Use a longer password.'}`,
  };
}

module.exports = { strength, meetsPolicy, MIN_SCORE };
