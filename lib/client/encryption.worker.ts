import { encryptContainer } from "./crypto";
import type { EncryptRequest, EncryptResponse } from "./worker-types";

// Use a small structural type. The app compiles with DOM, not WebWorker globals.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<EncryptRequest>) => void) | null;
  postMessage(message: EncryptResponse): void;
};
let started = false;
scope.onmessage = (event) => {
  if (started || event.data.type !== "encrypt") return;
  started = true;
  void encryptContainer(event.data.file, {
    onProgress: (progress) => scope.postMessage({ type: "progress", progress }),
  }).then(
    ({ blob, key }) => scope.postMessage({ type: "complete", blob, key }),
    () => scope.postMessage({ type: "error" }),
  );
};
