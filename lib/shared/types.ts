export interface CreateTransferRequest {
  size: number;
  encryptedSize: number;
  ttlSeconds: number;
}

export interface CreatedTransfer {
  id: string;
  uploadToken: string;
  deleteToken: string;
  uploadExpiresAt: string;
}

export interface TransferMetadata {
  id: string;
  size: number;
  encryptedSize: number;
  expiresAt: string;
}

export interface UploadedTransfer extends TransferMetadata {
  key: string;
  deleteToken: string;
}

export interface TransferProgress {
  stage: "encrypting" | "uploading" | "downloading" | "decrypting";
  loaded: number;
  total: number;
  percent: number;
}

export interface ApiErrorResponse {
  error: { code: string; message: string };
}
