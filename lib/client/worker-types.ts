import type { TransferProgress } from "../shared/types";

export interface EncryptRequest {
  type: "encrypt";
  file: File;
}

export type EncryptResponse =
  | { type: "progress"; progress: TransferProgress }
  | { type: "complete"; blob: Blob; key: string }
  | { type: "error" };
