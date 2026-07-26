# minecraft-bot

Mineflayer command-center bot controller for multiplayer servers.

The command-center bot only listens to chat commands starting with `+`, and controls managed bot instances.

## Features

- Admin-only chat commands
- Managed bot instances (`+bot add`, `+bot remove`, `+bot list`)
- Send chat as a managed bot (`+say`)
- Auto register/login detection for each joining bot using deterministic password:
  - password = first 8 chars of hex sha256(botname + serverip + "bot")
  - runs `/register <pass>` then `/login <pass>` when both commands exist
- Replies to command sender via `/w <username> <result>`

## Environment

Create `.env` from `.env.example`:

```env
SERVER_IP=minecraft.server.com
ADMIN=usernameOfUserToListenCommandsToCommaSeperated
CENTER_BOT_NAME=command-center
VIEW_DISTANCE=2
```

- `SERVER_IP` supports `host` or `host:port`
- `ADMIN` is comma-separated usernames allowed to run commands
- `CENTER_BOT_NAME` is optional
- `VIEW_DISTANCE` is chunks (integer `>= 2`) or one of `far|normal|short|tiny`, default `2`.
  Every bot decodes and tracks everything inside its view distance, so this is the
  main lever on CPU usage per bot. The sorter and crafter only look within 12
  blocks, so the default is plenty. Some servers clamp or ignore the client's
  request.

## Commands

These are sent in in-game chat:

```text
+bot add <botname>
+bot remove <botname>
+bot list

+say <botname> <message>
+sort <botname> enable
+sort <botname> disable
+eventreactor <botname> enable
+eventreactor <botname> disable
+eventreactor <botname> status
+eventreactor <botname> set <event|reaction|message|command|feature|health|cooldown> <value>
+er <botname> ...
+save <name>
+load <name> [waitMs]
+status <botname>
```

`+status` reports position, health, hunger, XP, enabled features, and CPU usage.
The CPU figures (per-bot and command center) are event loop utilization averaged
since the *previous* `+status` for that bot, so run it twice — the second reading
covers the interval between the two.

`+load` defaults to `5000ms` between bot joins when `waitMs` is omitted.

If a non-admin runs a command, they receive:

```text
/w <username> You dont have permition to use this command.
```

## Run Locally

```bash
npm install
cp .env.example .env
npm start
```

## Docker

### Build images

```bash
docker compose build
```

### Run command center

```bash
docker compose up -d runner
```

### Optional builder service

`docker-compose.yml` includes both:

- `builder`: build/install stage service
- `runner`: production runtime service
