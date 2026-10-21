# OMP Codex Voice

Live dictation for [Oh My Pi](https://github.com/can1357/oh-my-pi), using your existing Codex login. Speak, watch the transcript, then send or edit it. No spoken replies, separate API key, or microphone meter.

## Install

```sh
omp install github:TurabiOzturk/omp-codex-voice#v0.1.0
```

Restart OMP. Sign in to `openai-codex` through OMP if you haven't already. Disable any other plugin registering `/voice`.

Bundled audio helpers support macOS arm64 and Linux x64 with glibc and ALSA. Uses the system's default input device. Microphone permission is required.

## Use

Open `/voice` or double-tap Space.

| Key | Action |
| --- | --- |
| Space | Mute / resume |
| Double-Space | Finish and move the message to the normal editor, unsent |
| Enter | Send and keep listening |
| Escape | Discard the current dictation and exit |
| Arrows / Page keys | Scroll |

Double-Space means two taps within 400 ms. The panel waits for the final words before sending or returning to the editor.

Voice mode stays open while the agent responds. Wait for **Listening** after each send. Existing draft text is included in the first message; cancellation preserves it. Connection errors recover available text into the editor.

Mute stops forwarding new audio, but capture stays open and earlier audio may still produce text. Escape cannot retract audio already sent. Transcription requires OpenAI to accept your Codex OAuth credentials; the receiving agent can use any provider.

## Model

STT uses `gpt-live-transcribe`, configured in `buildDictationSessionUpdate()` in [transcriber.ts](src/voice/dictation/transcriber.ts). There is no model setting in JSON. Before changing it, check streaming event handling: committed-turn models are not drop-in replacements. Preserve Codex OAuth; no separately billed API-key fallback.

## Credits

Forked from Giuseppe Rodriguez's Pi Voice, itself a fork of Igor Warzocha's pi-gippity-control. Panel styling follows OMP's `/live`.

[MIT](LICENSE). Native helpers include Apache-2.0 code from [OpenAI Codex](https://github.com/openai/codex); see [third-party notices](THIRD-PARTY-NOTICES.txt) and [licenses](licenses/).
