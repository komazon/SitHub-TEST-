# Sit Git backend for ScratchWWW

Sit is an embedded Git history/Fork backend for ScratchWWW projects. There is no standalone `/sithub/` web application.

## User-facing routes

- `/projects/:id/` — ScratchWWW project page; the Remix action is presented as **Fork** and creates a Sit-backed project fork.
- `/projects/:id/commit_log` — commit history for the current user's fork (or the latest readable fork).
- `/projects/:id/commit/:hash` — commit details.

## API

All endpoints are same-origin under `/api/sit`. `GET /me` returns the current user and CSRF token. State-changing requests require `X-CSRF-Token`.

- `POST /projects/:id/fork` — import the public Scratch project into a new Sit `.sb3git` repository owned by the current user. Repeated Forks by the same user return the existing fork.
- `GET /projects/:id/commits` — read the commit log for a readable fork associated with the Scratch project ID.
- `GET /search` — server-side Scratch project/studio search.

The backend stores repository data in `sithub/data` by default. Configure persistence with `SITHUB_DATA_DIR`.
