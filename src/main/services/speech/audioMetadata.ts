import { execFile } from "node:child_process";

const audioProbeTimeoutMs = 10_000;

export function readAudioDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    if (process.platform === "darwin") {
      execFile("/usr/bin/afinfo", ["-i", filePath], {
        timeout: audioProbeTimeoutMs
      }, (error, stdout) => {
        const duration = stdout.match(/estimated duration:\s*([\d.]+)\s*sec/i)?.[1];
        const seconds = Number.parseFloat(duration ?? "");
        if (error || !Number.isFinite(seconds)) {
          reject(new Error("无法读取参考音频时长，请使用系统可读取的本地音频文件。"));
        } else {
          resolve(seconds);
        }
      });
      return;
    }

    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$audioPath = $env:ZHUOMIANLING_AUDIO_PATH",
      "$shell = New-Object -ComObject Shell.Application",
      "$folder = $shell.Namespace([System.IO.Path]::GetDirectoryName($audioPath))",
      "$item = $folder.ParseName([System.IO.Path]::GetFileName($audioPath))",
      "$duration = $item.ExtendedProperty('System.Media.Duration')",
      "if ($null -eq $duration) { throw '未读取到音频时长。' }",
      "[Console]::Out.WriteLine((([double]$duration / 10000000).ToString('R', [System.Globalization.CultureInfo]::InvariantCulture)))"
    ].join("; ");

    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: audioProbeTimeoutMs,
      windowsHide: true,
      env: { ...process.env, ZHUOMIANLING_AUDIO_PATH: filePath }
    }, (error, stdout) => {
      const seconds = Number.parseFloat(stdout.trim());
      if (error || !Number.isFinite(seconds)) {
        reject(new Error("无法读取参考音频时长，请使用系统可播放的本地音频文件。"));
      } else {
        resolve(seconds);
      }
    });
  });
}
