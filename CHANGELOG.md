# Changelog

## 0.1.0

- Initial OMP dictation fork of Pi Voice.
- Stream transcription using `gpt-live-transcribe` and OMP's existing Codex OAuth login.
- Keep the transcript panel open across sends while the agent responds.
- Open with `/voice` or double-Space; Space mutes, Enter sends, and Escape exits.
- Finish with double-Space to edit the finalized message in OMP's normal textbox without sending.
- Preserve editor drafts and recover available text after transcription errors.
- Ship the dictation entry point and native helper sources without inactive LAN or voice-conversation modules.
