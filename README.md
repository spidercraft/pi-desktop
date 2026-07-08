# Pi Desktop

Pi Desktop is a cross-platform desktop application for running an agent workspace from a native shell. It combines a Tauri desktop wrapper, a React interface, and a Node host process that connects the UI to a swappable agent harness.

The app provides chat-based workspace interaction, model and provider controls, permission handling, session resume, MCP server integration, file-aware tool output, and configurable appearance settings. Its internal packages separate the host adapter contract, shared protocol, UI tokens, desktop shell, and frontend so the agent backend can be changed without rewriting the interface.
