// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { html, render } from 'lit-html';

import { ScreencastCDPConnection, vscode } from './cdp';
import { MouseEventMap, ScreencastInputHandler } from './input';
import DimensionComponent from './dimensionComponent';
import {
  getEmulatedDeviceDetails,
  groupEmulatedDevicesByType,
} from './emulatedDeviceHelpers';
import FlyoutMenuComponent, { OffsetDirection } from './flyoutMenuComponent';

import { encodeMessageForChannel } from '../common/webviewEvents';

type NavigationEntry = {
  id: number;
  url: string;
};

export class Screencast {
  private cdpConnection = new ScreencastCDPConnection();
  private history: NavigationEntry[] = [];
  private historyIndex = 0;
  private inspectButton: HTMLButtonElement;
  private inputHandler: ScreencastInputHandler;
  private backButton: HTMLButtonElement;
  private forwardButton: HTMLButtonElement;
  private mainWrapper: HTMLElement;
  private reloadButton: HTMLButtonElement;
  private urlInput: HTMLInputElement;
  private screencastImage: HTMLImageElement;
  private toolbar: HTMLElement;
  private emulationBar: HTMLElement;
  private inactiveOverlay: HTMLElement;
  private emulatedWidth = 0;
  private emulatedHeight = 0;
  private inspectMode = false;
  private mediaFeatureConfig = new Map();
  private emulatedMedia = '';
  private isTouchMode = false;
  private deviceUserAgent = '';

  constructor() {
    this.backButton = document.getElementById('back') as HTMLButtonElement;
    this.forwardButton = document.getElementById(
      'forward'
    ) as HTMLButtonElement;
    this.inspectButton = document.getElementById(
      'inspect'
    ) as HTMLButtonElement;
    this.mainWrapper = document.getElementById('main') as HTMLElement;
    this.reloadButton = document.getElementById('reload') as HTMLButtonElement;
    this.urlInput = document.getElementById('url') as HTMLInputElement;
    this.screencastImage = document.getElementById(
      'canvas'
    ) as HTMLImageElement;
    this.toolbar = document.getElementById('toolbar') as HTMLElement;
    this.emulationBar = document.getElementById('emulation-bar') as HTMLElement;
    this.inactiveOverlay = document.getElementById(
      'inactive-overlay'
    ) as HTMLElement;

    this.backButton.addEventListener('click', () => this.onBackClick());
    this.forwardButton.addEventListener('click', () => this.onForwardClick());
    this.inspectButton.addEventListener('click', () => this.onInspectClick());
    this.reloadButton.addEventListener('click', () => this.onReloadClick());
    this.urlInput.addEventListener('keydown', event =>
      this.onUrlKeyDown(event)
    );

    const emulatedDevices = groupEmulatedDevicesByType();
    // InfobarComponent.render(
    //   {
    //     message:
    //       "This is a simulated preview with limited functionality. Deactivate 'Headless mode' in extension settings for a full experience.",
    //   },
    //   "infobar"
    // );
    FlyoutMenuComponent.render(
      {
        iconName: 'codicon-chevron-down',
        title: 'Emulate devices',
        globalSelectedItem: 'responsive',
        displayCurrentSelection: true,
        menuItemSections: [
          {
            onItemSelected: this.onDeviceSelected,
            menuItems: [{ name: 'Responsive', value: 'responsive' }],
          },
          {
            onItemSelected: this.onDeviceSelected,
            menuItems: emulatedDevices.get('phone') || [],
          },
          {
            onItemSelected: this.onDeviceSelected,
            menuItems: emulatedDevices.get('tablet') || [],
          },
          {
            onItemSelected: this.onDeviceSelected,
            menuItems: emulatedDevices.get('notebook') || [],
          },
        ],
      },
      'emulation-bar-right'
    );
    DimensionComponent.render(
      {
        width: this.mainWrapper.offsetWidth,
        height: this.mainWrapper.offsetHeight,
        heightOffset:
          this.toolbar.offsetHeight + this.emulationBar.offsetHeight,
        onUpdateDimensions: this.onUpdateDimensions,
      },
      'emulation-bar-center'
    );

    render(
      html`
        ${new FlyoutMenuComponent({
          iconName: 'codicon-wand',
          title: 'Emulate CSS media features',
          offsetDirection: OffsetDirection.Right,
          menuItemSections: [
            {
              onItemSelected: this.onEmulatedMediaSelected,
              menuItems: [
                { name: 'No media type emulation', value: '' },
                { name: 'screen', value: 'screen' },
                { name: 'print', value: 'print' },
              ],
            },
            {
              onItemSelected: this.onPrefersColorSchemeSelected,
              menuItems: [
                { name: 'No prefers-color-scheme emulation', value: '' },
                { name: 'prefers-color-scheme: light', value: 'light' },
                { name: 'prefers-color-scheme: dark', value: 'dark' },
              ],
            },
            {
              onItemSelected: this.onForcedColorsSelected,
              menuItems: [
                { name: 'No forced-colors emulation', value: '' },
                { name: 'forced-colors: none', value: 'none' },
                { name: 'forced-colors: active', value: 'active' },
              ],
            },
          ],
        }).template()}
        ${new FlyoutMenuComponent({
          iconName: 'codicon-eye',
          title: 'Emulate vision deficiencies',
          offsetDirection: OffsetDirection.Right,
          menuItemSections: [
            {
              onItemSelected: this.onVisionDeficiencySelected,
              menuItems: [
                { name: 'No vision deficiency emulation', value: 'none' },
                { name: 'Blurred vision', value: 'blurredVision' },
                { name: 'Protanopia', value: 'protanopia' },
                { name: 'Deuteranopia', value: 'deuteranopia' },
                { name: 'Tritanopia', value: 'tritanopia' },
                { name: 'Achromatopsia', value: 'achromatopsia' },
              ],
            },
          ],
        }).template()}
      `,
      document.getElementById('emulation-bar-left')!
    );

  this.cdpConnection.registerForEvent('Page.frameNavigated', result => {
    // Validate the result has the expected structure
    if (result && typeof result === 'object' && 'frame' in result) {
      this.onFrameNavigated(result as { frame: { parentId?: string } });
    } else {
      console.warn('Received unexpected format for Page.frameNavigated event:', result);
    }
    });
    this.cdpConnection.registerForEvent('Page.screencastFrame', result => {
      if (result && typeof result === 'object' && 'data' in result && 'sessionId' in result) {
        this.onScreencastFrame(result as { data: string; sessionId: string });
      } else {
        console.warn('Received unexpected format for Page.screencastFrame event:', result);
      }
    });
    this.cdpConnection.registerForEvent(
      'Page.screencastVisibilityChanged',
      result => {
        if (result && typeof result === 'object' && 'visible' in result) {
          this.onScreencastVisibilityChanged(result as { visible: boolean });
        } else {
          console.warn('Received unexpected format for Page.screencastVisibilityChanged event:', result);
        }
      }
    );

    // This message comes from the DevToolsPanel instance.
    this.cdpConnection.registerForEvent('DevTools.toggleInspect', (result: { enabled?: boolean }) => {
      if (result && typeof result.enabled === 'boolean') {
        this.onToggleInspect({ enabled: result.enabled ?? false });
      } else {
        console.warn('Received unexpected format for DevTools.toggleInspect event:', result);
      }
    });
    this.cdpConnection.registerWriteToClipboardFunction(result =>
      this.onSaveToClipboard(result)
    );
    this.cdpConnection.registerReadClipboardAndPasteFunction(() =>
      this.getClipboardContents()
    );
    this.cdpConnection.registerForEvent('readClipboard', clipboardContents => {
      if (typeof clipboardContents === 'string') {
        this.pasteClipboardContents(clipboardContents);
      } else {
        console.warn('Clipboard contents are not a string:', clipboardContents);
      }
    });

    this.inputHandler = new ScreencastInputHandler(this.cdpConnection);

    this.cdpConnection.sendMessageToBackend('Page.enable', {});

    // Optimizing the resize event to limit how often can it be called.
    let resizeTimeout = 0 as unknown as NodeJS.Timeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => this.updateEmulation(), 100);
    });

    this.registerInputListeners();

    // Start screencast
    this.updateEmulation();
    this.updateHistory();
  }

  private registerInputListeners(): void {
    // Disable context menu on screencast image
    this.screencastImage.addEventListener('contextmenu', event =>
      event.preventDefault()
    );

    for (const eventName of Object.keys(MouseEventMap)) {
      this.screencastImage.addEventListener(eventName, event => {
        const scale = this.screencastImage.offsetWidth / this.emulatedWidth;
        const mouseEvent = event as MouseEvent;
        if (this.isTouchMode && !this.inspectMode) {
          this.inputHandler.emitTouchFromMouseEvent(mouseEvent, scale);
        } else if (mouseEvent.button !== 2 /* right click */) {
          this.inputHandler.emitMouseEvent(mouseEvent, scale);
        }
      });
    }

    for (const eventName of ['keydown', 'keyup']) {
      this.screencastImage.addEventListener(eventName, event => {
        this.inputHandler.emitKeyEvent(event as KeyboardEvent);
      });
    }
  }

  private updateHistory(): void {
    this.cdpConnection.sendMessageToBackend(
      'Page.getNavigationHistory',
      {},
      (result: { currentIndex: number; entries: NavigationEntry[] }) => {
        const { currentIndex, entries } = result;
        this.history = entries;
        this.historyIndex = currentIndex;
        this.backButton.disabled = this.historyIndex < 1;
        this.forwardButton.disabled =
          this.historyIndex >= this.history.length - 1;
        this.urlInput.value = this.history[this.historyIndex].url;
      }
    );
  }

  private updateEmulation(): void {
    const isTouch = this.isTouchMode;
    const deviceMetricsParams = {
      width: this.emulatedWidth,
      height: this.emulatedHeight,
      deviceScaleFactor: 0,
      mobile: isTouch,
    };
    const touchEmulationParams = {
      enabled: isTouch,
      maxTouchPoints: 1,
    };

    this.cdpConnection.sendMessageToBackend('Emulation.setUserAgentOverride', {
      userAgent: this.deviceUserAgent,
    });
    this.cdpConnection.sendMessageToBackend(
      'Emulation.setDeviceMetricsOverride',
      deviceMetricsParams
    );
    this.cdpConnection.sendMessageToBackend(
      'Emulation.setTouchEmulationEnabled',
      touchEmulationParams
    );
    this.updateScreencast();
  }

  private onDeviceSelected = (value: string) => {
    const isResponsive = value === 'responsive';
    let isTouchMode = false;
    if (isResponsive) {
      this.emulatedWidth = this.mainWrapper.offsetWidth;
      this.emulatedHeight =
        this.mainWrapper.offsetHeight -
        this.toolbar.offsetHeight -
        this.emulationBar.offsetHeight;
      this.deviceUserAgent = '';
    } else {
      const device = getEmulatedDeviceDetails(value);
      if (!device) {
        return;
      }
      if (device.modes) {
        const defaultDeviceMode = device.modes.find(
          mode => mode.title === 'default'
        );

        if (!defaultDeviceMode) {
          throw new Error(
            `No default device mode in \`modes\` property for ${device.title}`
          );
        }

        this.emulatedWidth =
          device.screen[
            defaultDeviceMode.orientation as 'horizontal' | 'vertical'
          ].width;
        this.emulatedHeight =
          device.screen[
            defaultDeviceMode.orientation as 'horizontal' | 'vertical'
          ].height;
      } else {
        this.emulatedWidth = device.screen.vertical.width;
        this.emulatedHeight = device.screen.vertical.height;
      }
      this.deviceUserAgent = device['user-agent'];
      isTouchMode =
        device.capabilities.includes('touch') ||
        device.capabilities.includes('mobile');
    }

    this.setTouchMode(isTouchMode);
    DimensionComponent.setDimensionState(
      this.emulatedWidth,
      this.emulatedHeight,
      isResponsive,
      !isResponsive
    );
    this.updateEmulation();
    this.sendEmulationTelemetry('device', value);
  };

  private onVisionDeficiencySelected = (value: string) => {
    this.cdpConnection.sendMessageToBackend(
      'Emulation.setEmulatedVisionDeficiency',
      { type: value }
    );
    this.sendEmulationTelemetry('visionDeficiency', value);
  };

  private onEmulatedMediaSelected = (value: string) => {
    this.emulatedMedia = value;
    this.updateMediaFeatures();
    this.sendEmulationTelemetry('emulatedMedia', value);
  };

  private onForcedColorsSelected = (value: string) => {
    this.mediaFeatureConfig.set('forced-colors', value);
    this.updateMediaFeatures();
    this.sendEmulationTelemetry('forcedColors', value);
  };

  private onPrefersColorSchemeSelected = (value: string) => {
    this.mediaFeatureConfig.set('prefers-color-scheme', value);
    this.updateMediaFeatures();
    this.sendEmulationTelemetry('prefersColorScheme', value);
  };

  private onUpdateDimensions = (width: number, height: number) => {
    this.emulatedWidth = width;
    this.emulatedHeight = height;
    this.updateEmulation();
  };

  private updateMediaFeatures = () => {
    const features = [] as { name: string; value: string }[];
    this.mediaFeatureConfig.forEach((value: string, name: string) => {
      features.push({ name, value });
    });
    const payload = {
      features,
      media: this.emulatedMedia,
    };
    this.cdpConnection.sendMessageToBackend(
      'Emulation.setEmulatedMedia',
      payload
    );
  };

  private updateScreencast(): void {
    const screencastParams = {
      format: 'png',
      quality: 100,
      maxWidth: Math.floor(this.emulatedWidth * window.devicePixelRatio),
      maxHeight: Math.floor(this.emulatedHeight * window.devicePixelRatio),
    };
    this.cdpConnection.sendMessageToBackend(
      'Page.startScreencast',
      screencastParams
    );
  }

  private onBackClick(): void {
    if (this.historyIndex > 0) {
      const entryId = this.history[this.historyIndex - 1].id;
      this.cdpConnection.sendMessageToBackend('Page.navigateToHistoryEntry', {
        entryId,
      });
    }
  }

  private onForwardClick(): void {
    if (this.historyIndex < this.history.length - 1) {
      const entryId = this.history[this.historyIndex + 1].id;
      this.cdpConnection.sendMessageToBackend('Page.navigateToHistoryEntry', {
        entryId,
      });
    }
  }

  private onFrameNavigated({ frame }: { frame: { parentId?: string } }): void {
    if (!frame.parentId) {
      this.updateHistory();
    }
  }

  private onInspectClick(): void {
    vscode.postMessage({ type: 'open-devtools' });
  }

  private onReloadClick(): void {
    this.cdpConnection.sendMessageToBackend('Page.reload', {});
  }

  private onUrlKeyDown(event: KeyboardEvent): void {
    let url = this.urlInput.value;
    if (event.key === 'Enter' && url) {
      if (url.startsWith('/') || url[1] === ':') {
        try {
          url = new URL(`file://${url}`).href;
        } catch {
          // Try the original URL if it can't be converted to a file URL.
        }
      }
      if (
        !url.startsWith('http:') &&
        !url.startsWith('https:') &&
        !url.startsWith('file:')
      ) {
        url = 'http://' + url;
      }

      this.cdpConnection.sendMessageToBackend('Page.navigate', { url });
    }
  }

  private onScreencastFrame({ data, sessionId }: { data: string; sessionId: string }): void {
    const expectedRatio = this.emulatedWidth / this.emulatedHeight;
    const actualRatio =
      this.screencastImage.naturalWidth / this.screencastImage.naturalHeight;
    this.screencastImage.src = `data:image/png;base64,${data}`;
    if (expectedRatio !== actualRatio) {
      this.updateEmulation();
    }
    this.cdpConnection.sendMessageToBackend('Page.screencastFrameAck', {
      sessionId,
    });
  }

  private onScreencastVisibilityChanged({
    visible,
  }: {
    visible: boolean;
  }): void {
    if (!visible) {
      // If tab becomes inactive, try to re-enable it
      this.cdpConnection.sendMessageToBackend('Page.enable', {});
      // Request a new screencast frame
      this.updateScreencast();
    }
    this.inactiveOverlay.hidden = visible;
  }

  private onToggleInspect({ enabled }: { enabled: boolean }): void {
    this.setTouchMode(!enabled);
  }

  private onSaveToClipboard(message: string): void {
    encodeMessageForChannel(
      msg => vscode.postMessage(msg, '*'),
      'writeToClipboard',
      {
        data: {
          message,
        },
      }
    );
  }

  private sendEmulationTelemetry(event: string, value: string) {
    encodeMessageForChannel(
      msg => vscode.postMessage(msg, '*'),
      'telemetry',
      {
        event: 'screencast',
        name: 'Screencast.Emulation',
        data: {
          event,
          value,
        },
      }
    );
  }

  private getClipboardContents(): void {
    encodeMessageForChannel(
      msg => vscode.postMessage(msg, '*'),
      'readClipboard'
    );
  }

  private pasteClipboardContents(message: string) {
    this.cdpConnection.sendMessageToBackend('Runtime.evaluate', {
      expression: `document.execCommand("insertText", false, "${message.replace(
        /"/g,
        '\\"'
      )}");`,
    });
  }

  private setTouchMode(enabled: boolean): void {
    const touchEventsParams = {
      enabled,
      configuration: enabled ? 'mobile' : 'desktop',
    };
    this.screencastImage.classList.toggle('touch', enabled);
    this.cdpConnection.sendMessageToBackend(
      'Emulation.setEmitTouchEventsForMouse',
      touchEventsParams
    );
    this.isTouchMode = enabled;
  }
}
