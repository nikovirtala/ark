// ark's commit rules (AGENTS.md "Commit messages"): Conventional Commits with config-conventional's
// type list and default subject-case, and a description of at most 72 characters that doesn't
// start with an uppercase letter. header-max-length (100) counts the whole header, so the
// description needs its own length rule.
const MAX_DESCRIPTION = 72;

/** True when the rule holds; `when = "never"` inverts it, as commitlint's own rules do. */
const outcome = (when, ok, message) => [when === "never" ? !ok : ok, message];

export default {
  extends: ["@commitlint/config-conventional"],
  plugins: [
    {
      rules: {
        "description-max-length": ({ subject }, when = "always", max = MAX_DESCRIPTION) => {
          if (subject == null) return [true];
          const message = `description must be at most ${max} characters, found ${subject.length}`;
          return outcome(when, subject.length <= max, message);
        },
        // Only an uppercase or titlecase first character fails: a description may start with a
        // digit or punctuation ("2fa", "`adr index`"), as adr's own subjects can.
        "description-lowercase-start": ({ subject }, when = "always") => {
          const first = subject == null ? undefined : Array.from(subject)[0];
          if (first === undefined) return [true];
          const message = `description must start with a lowercase letter, found "${first}"`;
          return outcome(when, !/^[\p{Lu}\p{Lt}]$/u.test(first), message);
        },
      },
    },
  ],
  rules: {
    "description-max-length": [2, "always", MAX_DESCRIPTION],
    "description-lowercase-start": [2, "always"],
  },
};
