const { execPowershellAsync } = require("../lib/powershell");

const notificationTools = [
  {
    name: "show_notification",
    description: "Show a Windows toast notification (popup in the bottom-right corner of the screen).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Notification title" },
        message: { type: "string", description: "Notification body text" },
        duration_seconds: { type: "number", description: "How long to show it (default: 5)", default: 5 },
      },
      required: ["title", "message"],
    },
    handler: async ({ title, message, duration_seconds = 5 }) => {
      const ms = duration_seconds * 1000;
      const script = `
        Add-Type -AssemblyName System.Windows.Forms
        $n = New-Object System.Windows.Forms.NotifyIcon
        $n.Icon = [System.Drawing.SystemIcons]::Information
        $n.Visible = $true
        $n.ShowBalloonTip(${ms}, '${title.replace(/'/g, "''")}', '${message.replace(/'/g, "''")}', [System.Windows.Forms.ToolTipIcon]::Info)
        Start-Sleep -Milliseconds 500
        $n.Dispose()
      `;
      const res = await execPowershellAsync(script);
      if (res.status === 0) {
        return { success: true, data: { title, message } };
      }
      return { success: false, error: res.stderr || res.error || "Failed to show notification", code: "NOTIFICATION_FAILED" };
    },
  },
  {
    name: "show_dialog",
    description: "Show a popup message box dialog that waits for the user to click OK/Yes/No. Returns the button the user clicked.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Dialog title" },
        message: { type: "string", description: "Dialog message" },
        type: {
          type: "string",
          description: "Dialog type: ok, okcancel, yesno, yesnocancel (default: ok)",
          default: "ok",
        },
      },
      required: ["title", "message"],
    },
    handler: async ({ title, message, type = "ok" }) => {
      const buttonMap = {
        ok: "OK", okcancel: "OKCancel", yesno: "YesNo", yesnocancel: "YesNoCancel",
      };
      const buttons = buttonMap[type] || "OK";
      const script = `
        Add-Type -AssemblyName System.Windows.Forms
        $res = [System.Windows.Forms.MessageBox]::Show('${message.replace(/'/g, "''")}', '${title.replace(/'/g, "''")}', [System.Windows.Forms.MessageBoxButtons]::${buttons})
        Write-Output $res
      `;
      const res = await execPowershellAsync(script);
      if (res.status === 0) {
        return { success: true, data: { clicked: res.stdout } };
      }
      return { success: false, error: res.stderr || res.error || "Failed to show dialog", code: "DIALOG_FAILED" };
    },
  },
  {
    name: "speak_text",
    description: "Use Windows text-to-speech to speak text out loud through the speakers.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to speak" },
        rate: { type: "number", description: "Speaking rate: -10 (slow) to 10 (fast), default 0", default: 0 },
        volume: { type: "number", description: "Volume 0-100 (default: 100)", default: 100 },
      },
      required: ["text"],
    },
    handler: async ({ text, rate = 0, volume = 100 }) => {
      const script = `
        Add-Type -AssemblyName System.Speech
        $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
        $s.Rate = ${rate}
        $s.Volume = ${volume}
        $s.Speak('${text.replace(/'/g, "''")}')
        $s.Dispose()
      `;
      const res = await execPowershellAsync(script);
      if (res.status === 0) {
        return { success: true, data: { spoken: text } };
      }
      return { success: false, error: res.stderr || res.error || "TTS failed", code: "TTS_FAILED" };
    },
  },
  {
    name: "play_sound",
    description: "Play a system sound or a .wav file.",
    inputSchema: {
      type: "object",
      properties: {
        sound: {
          type: "string",
          description: "Sound name: beep, asterisk, exclamation, question, hand — or a path to a .wav file",
          default: "beep",
        },
      },
    },
    handler: async ({ sound = "beep" }) => {
      const soundMap = {
        beep: "[System.Console]::Beep(800, 300)",
        asterisk: "[System.Media.SystemSounds]::Asterisk.Play()",
        exclamation: "[System.Media.SystemSounds]::Exclamation.Play()",
        question: "[System.Media.SystemSounds]::Question.Play()",
        hand: "[System.Media.SystemSounds]::Hand.Play()",
      };

      let script = "Add-Type -AssemblyName System.Windows.Forms; ";
      if (soundMap[sound]) {
        script += soundMap[sound];
      } else {
        script += `(New-Object System.Media.SoundPlayer '${sound.replace(/'/g, "''")}').PlaySync()`;
      }

      const res = await execPowershellAsync(script);
      if (res.status === 0) {
        return { success: true, data: { sound } };
      }
      return { success: false, error: res.stderr || res.error || "Failed to play sound", code: "PLAY_SOUND_FAILED" };
    },
  },
  {
    name: "set_volume",
    description: "Set the system master audio volume (0-100) or mute.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "number", description: "Volume level 0-100" },
        mute: { type: "boolean", description: "If true, mute audio", default: false },
      },
      required: ["level"],
    },
    handler: async ({ level, mute = false }) => {
      const vol = Math.max(0, Math.min(100, level));
      // Using a reliable C# class through PowerShell to control master volume
      const script = `
        $vol = ${vol}
        $mute = $${mute ? "true" : "false"}
        Add-Type -TypeDefinition @'
        using System;
        using System.Runtime.InteropServices;
        
        [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioEndpointVolume {
            int RegisterControlChangeNotify(IntPtr pNotify);
            int UnregisterControlChangeNotify(IntPtr pNotify);
            int GetChannelCount(out uint pdcChannels);
            int SetMasterVolumeLevel(float fLevelDB, Guid pguidEventContext);
            int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
            int GetMasterVolumeLevel(out float pfLevelDB);
            int GetMasterVolumeLevelScalar(out float pfLevel);
            int SetChannelVolumeLevel(uint nChannel, float fLevelDB, Guid pguidEventContext);
            int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, Guid pguidEventContext);
            int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
            int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
            int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
            int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
        }
        
        [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDevice {
            int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        }
        
        [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDeviceEnumerator {
            int EnumAudioEndpoints(int dataFlow, int dwStateMask, out object ppDevices);
            int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
        }
        
        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
        class MMDeviceEnumerator {}
        
        public class VolumeControl {
            public static void SetVolume(float level, bool mute) {
                IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
                IMMDevice device;
                enumerator.GetDefaultAudioEndpoint(0, 1, out device);
                object volumeObject;
                Guid iidIAudioEndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
                device.Activate(ref iidIAudioEndpointVolume, 23, IntPtr.Zero, out volumeObject);
                IAudioEndpointVolume volume = (IAudioEndpointVolume)volumeObject;
                volume.SetMasterVolumeLevelScalar(level / 100f, Guid.Empty);
                volume.SetMute(mute, Guid.Empty);
            }
            public static float GetVolume() {
                IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
                IMMDevice device;
                enumerator.GetDefaultAudioEndpoint(0, 1, out device);
                object volumeObject;
                Guid iidIAudioEndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
                device.Activate(ref iidIAudioEndpointVolume, 23, IntPtr.Zero, out volumeObject);
                IAudioEndpointVolume volume = (IAudioEndpointVolume)volumeObject;
                float level;
                volume.GetMasterVolumeLevelScalar(out level);
                return level * 100f;
            }
        }
        '@
        [VolumeControl]::SetVolume($vol, $mute)
      `;
      const res = await execPowershellAsync(script);
      if (res.status === 0) {
        return { success: true, data: { volume: vol, muted: mute } };
      }
      return { success: false, error: res.stderr || res.error || "Failed to set volume", code: "SET_VOLUME_FAILED" };
    },
  },
  {
    name: "get_volume",
    description: "Get the current system master volume level.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      // Re-use same class to get the scalar volume
      const script = `
        Add-Type -TypeDefinition @'
        using System;
        using System.Runtime.InteropServices;
        [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioEndpointVolume {
            int _a(); int _b(); int _c(); int _d(); int _e();
            int GetMasterVolumeLevel(out float pfLevelDB);
            int GetMasterVolumeLevelScalar(out float pfLevel);
        }
        [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDevice {
            int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        }
        [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDeviceEnumerator {
            int _a();
            int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
        }
        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
        class MMDeviceEnumerator {}
        public class VolumeControl {
            public static float GetVolume() {
                IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
                IMMDevice device;
                enumerator.GetDefaultAudioEndpoint(0, 1, out device);
                object volumeObject;
                Guid iidIAudioEndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
                device.Activate(ref iidIAudioEndpointVolume, 23, IntPtr.Zero, out volumeObject);
                IAudioEndpointVolume volume = (IAudioEndpointVolume)volumeObject;
                float level;
                volume.GetMasterVolumeLevelScalar(out level);
                return level * 100f;
            }
        }
'@
[VolumeControl]::GetVolume()
      `.trim();
      const res = await execPowershellAsync(script);
      if (res.status === 0 && res.stdout) {
        return { success: true, data: { volume: Math.round(parseFloat(res.stdout)) } };
      }
      return { success: false, error: res.stderr || res.error || "Failed to get volume", code: "GET_VOLUME_FAILED" };
    },
  },
];

module.exports = notificationTools;
