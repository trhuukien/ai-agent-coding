# AI Support Theme — dispatcher

**Claude Code auto-loads this exact file into every session's context, regardless of what task is
being requested — that's a hardcoded harness behavior, not a choice made by this project.** Because
of that, this file is deliberately kept minimal: it must never inline either real playbook's actual
steps, or every session (Setup or Test) would pay the token cost of loading BOTH playbooks' full
detail even though a given run only ever needs one. Instead, each playbook lives in its own file and
gets `Read` on demand, only once the trigger below tells you which one actually applies.

This project has two SEPARATE, independent tasks, triggered by different wording, never run
together in the same pass:

- **Auto-SETUP** — build/reconfigure a theme's pages from Figma. Full playbook:
  [`SETUP.md`](SETUP.md). Triggered by a message shaped like `Setup: ...` (or `setup theme
  <store>.myshopify.com theme <themeId>`) combined with a `figma.com/design/...` URL — see
  `SETUP.md`'s own Trigger section for the exact recognition rules, including the admin editor URL
  form and its parser.
- **Auto-TEST** — verify an ALREADY-BUILT theme against its Figma design and log results to the
  team's tracking spreadsheet; never writes section config, only screenshots/compares/logs. Full
  playbook: [`AUTOTEST.md`](AUTOTEST.md). Triggered by a message shaped like `Test: ...` combined
  with a `figma.com/design/...` URL.

## What to do

1. Read the user's message against both trigger shapes above.
2. Setup triggered → `Read` `SETUP.md` in full, then follow it top to bottom. Do not run any of its
   steps from memory of a prior session — always Read it fresh in THIS session, since its content is
   deliberately kept out of this always-loaded file for exactly that reason.
3. Test triggered → `Read` `AUTOTEST.md` in full, then follow its own Trigger/Prerequisites/
   Step-by-step structure. Do not run `SETUP.md`'s build steps (pulling a theme, writing section
   config, `apply-section.js`, etc.) for a Test-triggered request — Auto-test assumes the theme
   already exists and only reads/compares/logs.
4. Neither shape matches clearly, or the message is genuinely ambiguous about store/theme/Figma
   identity → ask before guessing. Don't speculatively start either playbook's steps.
