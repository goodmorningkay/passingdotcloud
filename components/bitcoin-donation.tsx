"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { Check, Copy } from "lucide-react";
import styles from "./bitcoin-donation.module.css";

export function BitcoinDonation({
  address,
  uri,
  qrSource,
}: {
  address: string;
  uri: string;
  qrSource: string;
}) {
  const addressInput = useRef<HTMLTextAreaElement>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const copied = copyStatus === "Address copied";

  async function copyAddress() {
    setCopyStatus("");
    try {
      await navigator.clipboard.writeText(address);
      setCopyStatus("Address copied");
    } catch {
      addressInput.current?.focus();
      addressInput.current?.select();
      setCopyStatus("Address selected. Copy it from the field.");
    }
  }

  return (
    <div>
      <Image
        className={styles.qr}
        src={qrSource}
        alt="Bitcoin payment QR code"
        width={222}
        height={222}
        unoptimized
      />
      <label className="field-label" htmlFor="bitcoin-address">
        Bitcoin address
      </label>
      <textarea
        className={styles.address}
        id="bitcoin-address"
        ref={addressInput}
        aria-describedby="bitcoin-network"
        readOnly
        value={address}
        rows={2}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        onFocus={(event) => event.currentTarget.select()}
      />
      <div className={styles.actions}>
        <button
          type="button"
          className="button button-primary"
          onClick={copyAddress}
        >
          {copied ? (
            <Check size={17} aria-hidden="true" />
          ) : (
            <Copy size={17} aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy address"}
        </button>
        <a href={uri} className="button button-secondary">
          Open Bitcoin wallet
        </a>
      </div>
      <p
        className={copied ? "visually-hidden" : "copy-feedback small"}
        role="status"
      >
        {copyStatus}
      </p>
    </div>
  );
}
