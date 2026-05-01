# Local API Endpoints

This document describes the local LAN/loopback API exposed by the Android app
when the Local API Server setting is enabled. The server is intended to make the
phone manageable as a long-running local model host.

## Base URLs

The app reports active endpoints in `GET /v1/status`.

- LAN: `http://<phone-lan-ip>:3333`
- Loopback from the same Android device: `http://127.0.0.1:3333`
- Localhost alias: `http://localhost:3333`

The port comes from `settings.localApiServerPort` and defaults to `3333`.

## Authentication

`GET /health` is unauthenticated so clients can detect whether the native server
is alive. All other routes require authentication if an API key is configured in
the app.

Use either header:

```bash
Authorization: Bearer offgrid-your-key
X-Api-Key: offgrid-your-key
```

If no API key is configured, protected endpoints are open on the local network.
For deployment, configure an API key before exposing the server to a LAN.

## Response Conventions

Most management responses include:

- `object`: response type, for example `offgrid.models.load`.
- `ok`: boolean success flag for action endpoints.
- `offgrid.operation`: current or completed operation metadata.
- `X-Offgrid-Api-Version`: API version header, currently `1`.
- `X-Offgrid-Operation-Id` and `X-Offgrid-Stage`: progress headers when relevant.
- `Retry-After`: returned with `429` when native or JS-side queues are full.

Errors return JSON:

```json
{
  "error": {
    "message": "Missing or invalid API key",
    "status": 401
  }
}
```

## Health And Discovery

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | No | Native server liveness check. Does not require the JS bridge. |
| `GET` | `/v1/status` | Yes | Full server, model, runtime, resource, and operation status. |
| `GET` | `/v1/capabilities` | Yes | Lists supported OpenAI-compatible and management endpoints. |
| `GET` | `/v1/offgrid/capabilities` | Yes | Alias for `/v1/capabilities`. |

Example:

```bash
curl "$BASE/v1/status" -H "Authorization: Bearer $OFFGRID_API_KEY"
```

`/v1/status` includes server URLs, model counts, active models, loaded models,
latest operation state, resource usage, text generation state, image generation
state, download counts, gallery counts, API queue depth, watchdog state, and
single-model API mode.

## OpenAI-Compatible Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/models` | Lists downloaded text, vision-capable, and image models. |
| `POST` | `/v1/chat/completions` | Runs local text generation. Supports streaming. |
| `POST` | `/v1/images/generations` | Runs local image generation. |

Chat example:

```bash
curl "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $OFFGRID_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-text-model-id",
    "messages": [{"role": "user", "content": "Write one sentence."}],
    "temperature": 0.7,
    "max_tokens": 128,
    "stream": false
  }'
```

Supported chat fields: `model`, `messages`, `stream`, `temperature`,
`max_tokens`, `max_completion_tokens`, `top_p`, `repeat_penalty`, `tools`,
`unload_other`, and `unloadOther`. Message roles supported: `system`, `user`,
`assistant`, and `tool`.

Image example:

```bash
curl "$BASE/v1/images/generations" \
  -H "Authorization: Bearer $OFFGRID_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-image-model-id",
    "prompt": "a compact solar-powered server phone on a desk",
    "negative_prompt": "blurry",
    "size": "512x512",
    "steps": 20,
    "guidance_scale": 7.5,
    "response_format": "b64_json"
  }'
```

Supported image fields: `model`, `prompt`, `negative_prompt`,
`negativePrompt`, `size`, `steps`, `guidance_scale`, `guidanceScale`, `seed`,
`response_format`, `unload_other`, and `unloadOther`. Only `n=1` is supported.

## Model Lifecycle

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/models/load` | Load a text or image model. |
| `POST` | `/v1/models/load/text` | Load the active or specified text model. |
| `POST` | `/v1/models/load/image` | Load the active or specified image model. |
| `POST` | `/v1/models/reload` | Unload and load target model resources. |
| `POST` | `/v1/models/reload/text` | Reload text model resources. |
| `POST` | `/v1/models/reload/image` | Reload image model resources. |
| `POST` | `/v1/models/reload/all` | Reload available text and image resources. |
| `POST` | `/v1/models/unload` | Unload text, image, or all loaded resources. |
| `POST` | `/v1/models/unload/text` | Unload text model resources. |
| `POST` | `/v1/models/unload/image` | Unload image model resources. |
| `POST` | `/v1/models/unload/all` | Unload all model resources. |
| `POST` | `/v1/models/delete` | Delete a downloaded model file and store entry. |
| `POST` | `/v1/models/delete/text` | Delete a text model by id. |
| `POST` | `/v1/models/delete/image` | Delete an image model by id. |

Load body:

```json
{
  "target": "text",
  "model": "your-text-model-id",
  "unload_other": true
}
```

Valid targets are `text`, `image`, and `all` where the route allows it.
Aliases such as `llm`, `chat`, `language`, `images`, `vision`, and `diffusion`
are normalized where applicable. `unload_other` defaults to `true` for explicit
model load/reload calls. Delete requires `model`, `model_id`, or `id`.

## Generation Control

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/generation/stop` | Stop text, image, or all generation. |
| `POST` | `/v1/generation/stop/text` | Stop text generation. |
| `POST` | `/v1/generation/stop/image` | Stop image generation. |
| `POST` | `/v1/generation/stop/all` | Stop text and image generation. |
| `POST` | `/v1/generation/cancel` | Alias for stop. |
| `POST` | `/v1/generation/cancel/text` | Alias for text stop. |
| `POST` | `/v1/generation/cancel/image` | Alias for image stop. |
| `POST` | `/v1/generation/cancel/all` | Alias for all stop. |

Example:

```bash
curl "$BASE/v1/generation/stop/all" \
  -H "Authorization: Bearer $OFFGRID_API_KEY" \
  -X POST -d '{}'
```

## Cache Management

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/cache/clear` | Clear text cache by default, or requested target. |
| `POST` | `/v1/cache/clear/text` | Clear LLM KV cache. |
| `POST` | `/v1/cache/clear/image` | Clear image OpenCL cache for active image model. |
| `POST` | `/v1/cache/clear/all` | Clear both cache types. |

Optional body:

```json
{
  "target": "all",
  "clear_data": true
}
```

## Settings

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/settings` | Return app settings with API key redacted. |
| `GET` | `/v1/offgrid/settings` | Alias for `/v1/settings`. |
| `POST` | `/v1/settings` | Patch valid settings fields. |
| `POST` | `/v1/offgrid/settings` | Alias for settings patch. |
| `PATCH` | `/v1/settings` | Also accepted by the handler. |
| `PATCH` | `/v1/offgrid/settings` | Also accepted by the handler. |

Example:

```bash
curl "$BASE/v1/settings" \
  -H "Authorization: Bearer $OFFGRID_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "settings": {
      "localApiServerEnabled": true,
      "localApiServerPort": 3333,
      "localApiServerApiKey": "offgrid-new-key"
    }
  }'
```

Only keys already present in the app settings store are accepted. Values must
match the existing setting type. API server setting changes schedule a server
reconfigure after the response is returned.

`localApiServerSingleModelMode` defaults to `true`. When enabled, API chat and
image requests unload the opposite model type before loading the requested model
unless a request explicitly passes `"unload_other": false`.

## Robustness Behavior

- Non-status work is serialized in the JS API queue to avoid overlapping model
  loads, image generation, and model deletion.
- `/v1/status`, `/v1/models`, `/v1/capabilities`, `GET /v1/settings`,
  `/v1/generation/stop*`, and `/v1/server/*` bypass the queue so clients can
  observe and control the server while heavy work is running.
- The JS queue rejects new queued work with `429` when more than 8 requests are
  waiting.
- The native bridge rejects new protected requests with `429` when more than 16
  requests are pending a JS response.
- A watchdog runs while the API server setting is enabled. If the native HTTP
  server is no longer alive, it attempts to reconfigure and restart it.
- `/health` reports native liveness, JS readiness, pending request count, active
  stream count, API-key configuration, uptime, and last request timestamp.

## Gallery

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/gallery/images` | Sync and list generated images. |
| `POST` | `/v1/gallery/delete` | Delete generated images by id, ids, conversation, or all. |
| `POST` | `/v1/gallery/images/delete` | Alias for gallery deletion. |
| `DELETE` | `/v1/gallery/images/{id}` | Delete a single generated image. |

Delete examples:

```json
{"id": "image-id"}
{"ids": ["image-id-1", "image-id-2"]}
{"conversation_id": "conversation-id"}
{"all": true}
```

Deletion removes generated-image records from the app store and attempts to
delete the backing files through the local image generator service.

## Downloads

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/downloads` | List active native downloads and persisted download state. |
| `POST` | `/v1/downloads/cancel` | Cancel a background download by id. |
| `POST` | `/v1/downloads/cancel/{downloadId}` | Cancel a background download by path id. |

Body example:

```json
{"download_id": 123}
```

This API can cancel known background downloads. Starting new model downloads is
not exposed yet.

## Storage

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/storage` | Return model storage usage, available bytes, and orphaned files. |
| `POST` | `/v1/storage/scan` | Refresh model lists and return storage snapshot. |
| `POST` | `/v1/storage/orphans/delete` | Delete one known orphaned file. |

Orphan deletion body:

```json
{"path": "/absolute/path/from-the-orphan-list"}
```

For safety, arbitrary paths are rejected. The path must exactly match an entry
returned by `modelManager.getOrphanedFiles()`.

## Server Lifecycle

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/server/reload` | Re-run server configuration. |
| `POST` | `/v1/server/restart` | Stop and start the local API server. |
| `POST` | `/v1/server/stop` | Disable and stop the local API server. |

Server actions return before the action runs. Restart and stop return `202`.
Use `/health` and `/v1/status` to verify the final state.

## Current Limitations And Gaps

- The server still depends on the Android app process and React Native JS bridge
  for protected API routes. `/health` can respond without the bridge; model and
  management routes cannot.
- There is no true Android process force-restart endpoint. `/v1/server/restart`
  restarts the embedded HTTP server, not the whole app process.
- Starting new model downloads, browsing remote model catalogs, project CRUD,
  chat history CRUD, knowledge-base operations, voice transcription, TTS, and
  remote server management are not exposed yet.
- Vision inputs in `/v1/chat/completions` are rejected with `501`; text-only
  chat is supported.
- Image generation supports one image per request only (`n=1`).
- `response_format: "url"` returns a `data:image/png;base64,...` URL, not a
  separately hosted file URL.
- Destructive routes exist for models, gallery images, downloads, cache, server
  state, and known orphan files. Use an API key before LAN deployment.

## Deployment Checklist

1. Enable Local API Server in the app.
2. Set `localApiServerApiKey`.
3. Confirm `/health` from LAN and from Termux loopback.
4. Confirm `/v1/status` with the API key.
5. Use `/v1/models/unload/all` before switching between large text and image
   models on RAM-constrained devices.
6. Monitor `offgrid.operation` and `X-Offgrid-Stage` for slow model loads and
   long-running generation.
