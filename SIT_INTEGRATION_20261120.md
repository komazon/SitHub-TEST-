# ScratchWWW native Sit integration (2026-11-20)

## Architecture
- The standalone `/sithub/` web application and its static assets have been removed from the served application.
- Sit's JSON API is mounted at `/api/sit`.
- ScratchWWW remains the owner of project, profile, account, and navigation UI.

## Project integration
- The project page's Remix action is relabeled **Fork** and creates a Sit `.sb3git` fork from the public Scratch project.
- Forks are associated with the original Scratch project ID via `sourceProjectId`.
- `/projects/:id/commit_log` renders the commit history in a ScratchWWW-styled page.
- `/projects/:id/commit/:hash` renders commit details.
- The project page also links to Commit history.

## API additions
- `POST /api/sit/projects/:id/fork` imports the public Scratch `.sb3` as a Sit repository. Repeated requests by the same account return the existing fork.
- `GET /api/sit/projects/:id/commits` returns the readable fork's commit history.
- Existing search API is now accessed at `/api/sit/search`.

## Validation
- `node --check sithub/server.cjs`: passed.
- `node --check dev-server/index.js`: passed.
- Confirmed no served `/sithub/` static route remains.
- Full Webpack build and browser integration test were not run because root npm dependencies are not installed in this working copy.
