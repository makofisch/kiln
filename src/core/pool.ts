import { BlenderBridge } from './blender.ts';

/**
 * Keeps one Blender started ahead of time, so opening a project (a new tab) doesn't wait for
 * Blender to boot. Each project takes the spare and a new one warms up behind it.
 */
export class BlenderPool {
  private spare: BlenderBridge | null = null;
  private exe: string | null;
  private readonly script: string;

  constructor(exe: string | null, script: string) {
    this.exe = exe;
    this.script = script;
  }

  get available(): boolean {
    return !!this.exe;
  }

  /** Blender was installed while Kiln was open. */
  found(exe: string): void {
    this.exe = exe;
    this.warm();
  }

  warm(): void {
    if (!this.exe || this.spare) return;
    const b = new BlenderBridge(this.exe, this.script);
    this.spare = b;
    b.start().catch(() => {
      if (this.spare === b) this.spare = null;
    });
  }

  acquire(): BlenderBridge {
    const b = this.spare && this.spare.alive ? this.spare : new BlenderBridge(this.exe, this.script);
    this.spare = null;
    setTimeout(() => this.warm(), 2000).unref();
    return b;
  }

  stop(): void {
    this.spare?.stop();
    this.spare = null;
  }
}
