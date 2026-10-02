// Serves the synthetic Acme Notes app for the opt-in browser test.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env.ACME_NOTES_PORT ?? "4317");
const routes = {
  "/notes": ["app/notes.html", "text/html"],
  "/notes/empty": ["app/notes-empty.html", "text/html"],
  "/notes/1": ["app/note.html", "text/html"],
  "/app.css": ["app/app.css", "text/css"],
};

createServer((request, response) => {
  const route = routes[new URL(request.url ?? "/", "http://localhost").pathname];
  if (!route) {
    response.writeHead(404).end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": `${route[1]}; charset=utf-8` });
  response.end(readFileSync(new URL(route[0], import.meta.url)));
}).listen(port, "127.0.0.1");
