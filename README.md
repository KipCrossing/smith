# Smith

A small desktop text editor. It opens a folder, edits files, and can search, diff, and commit them. An optional side panel talks to a local [Ollama](https://ollama.com) model.

## Context

The agent should see as little as possible, and what it sees should be right. You choose that.

Paste a selection from a file and the panel cites that file and those lines, then keeps the file in the session. Remove a file from the context list when you are done with it. Agent settings shows how much of the model's window is instructions, tools, the project map, the conversation, and the files you loaded. Each step of a run shows that step's prompt size and how many tokens it added. The project map is a short index of folders and symbol names. A new session starts with an empty conversation and no loaded files.

## Run

```sh
npm install
npm run dev
```

`npm run build` typechecks and builds. `npm start` builds, then opens the built app.

The agent panel needs Ollama running on `http://localhost:11434`. The rest of the editor works without it.

## License

[Apache-2.0](LICENSE)
