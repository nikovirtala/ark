# Drop dangling short words from file slugs

## Problem
Slugs are cut at 60 characters on a word boundary, and can end in a word that only makes sense with the next one: `…-the-api-and-the.md`, `…-a-relink-every.md`.

## Proposal
After cutting, drop trailing short words such as a, an, and, the, to, of, for, every, until the slug ends in a word that carries meaning.

## Done when
- `slugify` drops a trailing run of short words after cutting, and keeps the slug at 60 characters or fewer.
- Existing files keep their names.
- Tests cover a title whose cut ends on such a word.
- The README's layout section says slugs are cut at 60 characters, so a long title gets a shortened file name.
