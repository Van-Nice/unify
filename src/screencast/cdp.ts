// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import {
  encodeMessageForChannel,
  parseMessageFromChannel,
} from "../common/webviewEvents";

declare const acquireVsCodeApi: () => {
  postMessage(message: unknown, args?: any | undefined): void;
};
export const vscode = acquireVsCodeApi();

interface CdpMessage {
  id: number;
  method: string;
  params?: any;
  result?: any;
}

export type CdpEventCallback = (params: any) => void;
export type CdpMethodCallback = (result: any) => void;

export class ScreencastCDPConnection {
  private nextId: number = 0;
  private eventCallbackMap: Map<string, CdpEventCallback[]> = new Map();
  private methodCallbackMap: Map<number, CdpMethodCallback> = new Map();
  private clipboardRequests: Set<number> = new Set();
  private saveToClipboard?: (message: string) => void;
  private readClipboardAndPaste?: () => void;
  private isConnected: boolean = false;

  constructor() {
    // Handle CDP messages/events routed from the extension through post message
    window.addEventListener("message", (e) => {
      parseMessageFromChannel(e.data, (eventName, args) => {
        if (eventName === "websocket") {
          const { message } = JSON.parse(args) as { message: string };
          if (message) {
            // Handle event responses
            const messageObj = JSON.parse(message) as CdpMessage;
            const callbacks =
              this.eventCallbackMap.get(messageObj.method) || [];
            callbacks.forEach((callback) => callback(messageObj.params));

            // Handle method responses
            const methodCallback = this.methodCallbackMap.get(messageObj.id);
            if (methodCallback) {
              methodCallback(messageObj.result);
              this.methodCallbackMap.delete(messageObj.id);
            }
            if (
              this.clipboardRequests.has(messageObj.id) &&
              this.saveToClipboard
            ) {
              this.saveToClipboard(
                (messageObj as { result: { result: { value: string } } }).result
                  .result.value
              );
              this.clipboardRequests.delete(messageObj.id);
            }
          }
          return true;
        }
        if (eventName === "toggleInspect") {
          const { enabled } = JSON.parse(args) as { enabled: string };
          const callbacks =
            this.eventCallbackMap.get("DevTools.toggleInspect") || [];
          callbacks.forEach((callback) => callback(enabled));
        }
        if (eventName === "readClipboard") {
          const { clipboardText } = JSON.parse(args) as {
            clipboardText: string;
          };
          const callbacks = this.eventCallbackMap.get("readClipboard") || [];
          callbacks.forEach((callback) => callback(clipboardText));
        }
        return false;
      });
    });
  }

  sendMessageToBackend(
    method: string,
    params: any,
    callback?: CdpMethodCallback,
    isCutOrCopy?: boolean
  ): void {
    const id = this.nextId++;
    const cdpMessage: CdpMessage = {
      id,
      method,
      params,
    };
    if (callback) {
      this.methodCallbackMap.set(id, callback);
    }
    if (isCutOrCopy) {
      this.clipboardRequests.add(id);
    }
    encodeMessageForChannel(
      (msg) => vscode.postMessage(msg, "*"),
      "websocket",
      { message: JSON.stringify(cdpMessage) }
    );
  }

  registerForEvent(method: string, callback: CdpEventCallback): void {
    if (!this.eventCallbackMap.has(method)) {
      this.eventCallbackMap.set(method, []);
    }
    this.eventCallbackMap.get(method)?.push(callback);
  }

  registerWriteToClipboardFunction(
    saveToClipboard: (message: string) => void
  ): void {
    this.saveToClipboard = saveToClipboard;
  }

  registerReadClipboardAndPasteFunction(
    readClipboardAndPaste: () => void
  ): void {
    this.readClipboardAndPaste = readClipboardAndPaste;
  }

  readClipboardAndPasteRequest(): void {
    this.readClipboardAndPaste?.();
  }

  private async connect(): Promise<void> {
    this.isConnected = true;
  }

  private async dispose(): Promise<void> {
    this.isConnected = false;
  }

  private async reconnect(): Promise<void> {
    try {
      await this.dispose();
      await this.connect();
      this.registerEventHandlers();
    } catch (error) {
      console.error("Failed to reconnect CDP:", error);
    }
  }

  private registerEventHandlers(): void {
    this.registerForEvent("Page.screencastVisibilityChanged", () => {
      if (!this.isConnected) {
        this.reconnect();
      }
    });
  }
}
