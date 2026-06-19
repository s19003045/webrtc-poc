# Repository Guidelines

## Project Structure & Module Organization

This repository is a staged WebRTC proof of concept. Each `phase-*` directory is mostly self-contained:

- `phase-1/`: 1:1 WebRTC call with an Express static server, `ws` signaling, and vanilla assets in `public/`.
- `phase-2/`: multi-user mesh calling, DataChannel chat, and screen sharing.
- `phase-3/`: React + TypeScript + Vite client in `client/`, with the Node signaling server in `server/`.
- `phase-4/`: Go signaling server in `server/`, reusing the Phase 3 React client.
- `phase-5/`: Go + Pion SFU server, React client, and SFU integration tests.

Root `docker-compose.yml` and `DOCKER.md` cover containerized runs.

## Build, Test, and Development Commands

- `cd phase-1 && npm install && npm start`: run the 1:1 Node demo.
- `cd phase-2 && npm install && npm start`: run the mesh demo.
- `cd phase-3/server && npm start`, plus `cd phase-3/client && npm run dev`: run Phase 3.
- `cd phase-3/client && npm run build`: type-check and build React.
- `cd phase-4/server && go run .`: run Go signaling after building Phase 3 client.
- `cd phase-5/server && go run .`: run the SFU server.
- `docker compose up -d --build`: build and start configured phases.

## Coding Style & Naming Conventions

Use the existing local style. JavaScript and TypeScript use 2-space indentation, single quotes, semicolons, `const`/`let`, PascalCase React components, and `use*` hook names. Format Go with `gofmt`; keep `phase-*/server/` files small and role-oriented. Keep user-facing demo text consistent with the existing Traditional Chinese copy.

## Testing Guidelines

Phase 5 has Go integration tests in `phase-5/server/*_test.go`; run `cd phase-5/server && go test -v`. To test a live SFU, set `SFU_WS_URL=ws://localhost:8085/ws` and optionally `SFU_CLIENTS=6`. For React clients, `npm run build` is the primary verification. For WebRTC behavior, manually test multiple browser tabs in the same room.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries, often in Chinese and phase-scoped, such as `完成 Phase 3：前端改寫為 React + TypeScript + Vite`. Keep commits focused on one phase or concern. Pull requests should describe the phase affected, list commands run, call out manual browser coverage, link issues, and include screenshots or recordings for UI changes.

## Security & Configuration Tips

This is a POC: signaling code may allow broad origins, and browser camera/microphone permissions are required. Prefer existing environment variables, such as `PORT`, `STATIC_DIR`, `SFU_WS_URL`, and `SFU_CLIENTS`, instead of hardcoding local values.
