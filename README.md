# Smith

A small desktop text editor. It opens a folder, edits files, and can search, diff, and commit them. An optional side panel talks to a local [Ollama](https://ollama.com) model.

## Run

```sh
npm install
npm run dev
```

`npm run build` typechecks and builds. `npm start` builds, then opens the built app.

The agent panel needs Ollama running on `http://localhost:11434`. The rest of the editor works without it.

## License

[Apache-2.0](LICENSE)
