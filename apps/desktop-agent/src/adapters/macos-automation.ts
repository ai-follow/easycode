import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type MacWindowInfo = {
  title: string;
  windowIndex: number;
};

export const runOsa = async (script: string, args: string[] = []): Promise<{ stdout: string; stderr: string }> => {
  const result = await execFileAsync("osascript", ["-e", script, ...args], {
    timeout: 10000,
    maxBuffer: 1024 * 1024
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
};

export const discoverProcessWindows = async (processName: string): Promise<MacWindowInfo[]> => {
  const script = `
    on run argv
      set processName to item 1 of argv
      tell application "System Events"
        if not (exists process processName) then
          return ""
        end if
        set output to ""
        tell process processName
          set windowIndex to 1
          repeat with w in windows
            set output to output & windowIndex & tab & (name of w as text) & linefeed
            set windowIndex to windowIndex + 1
          end repeat
        end tell
        return output
      end tell
    end run
  `;

  const { stdout } = await runOsa(script, [processName]);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [rawIndex, ...titleParts] = line.split("\t");
      return {
        windowIndex: Number(rawIndex),
        title: titleParts.join("\t").trim()
      };
    })
    .filter((window) => Number.isInteger(window.windowIndex) && window.windowIndex > 0 && window.title.length > 0);
};

export const dumpAccessibilityTree = async (processName: string, windowIndex: number): Promise<string> => {
  const script = `
    on sanitize(rawValue)
      set valueText to ""
      try
        set valueText to rawValue as text
      end try
      set AppleScript's text item delimiters to "\\\\"
      set parts to every text item of valueText
      set AppleScript's text item delimiters to "\\\\\\\\"
      set valueText to parts as text
      set AppleScript's text item delimiters to tab
      set parts to every text item of valueText
      set AppleScript's text item delimiters to "\\\\t"
      set valueText to parts as text
      set AppleScript's text item delimiters to linefeed
      set parts to every text item of valueText
      set AppleScript's text item delimiters to "\\\\n"
      set valueText to parts as text
      set AppleScript's text item delimiters to return
      set parts to every text item of valueText
      set AppleScript's text item delimiters to "\\\\n"
      set valueText to parts as text
      set AppleScript's text item delimiters to ""
      return valueText
    end sanitize

    on run argv
      set processName to item 1 of argv
      set windowIndex to (item 2 of argv) as integer
      tell application "System Events"
        if not (exists process processName) then error "Process is not running: " & processName
        tell process processName
          set frontmost to true
          set targetWindow to window windowIndex
          set output to ""
          repeat with elementRef in entire contents of targetWindow
            set roleValue to ""
            set roleDescriptionValue to ""
            set nameValue to ""
            set elementValue to ""
            set descriptionValue to ""
            set enabledValue to "false"
            try
              set roleValue to role of elementRef as text
            end try
            try
              set roleDescriptionValue to role description of elementRef as text
            end try
            try
              set nameValue to name of elementRef as text
            end try
            try
              set elementValue to value of elementRef as text
            end try
            try
              set descriptionValue to description of elementRef as text
            end try
            try
              if enabled of elementRef is true then set enabledValue to "true"
            end try
            set output to output & sanitize(roleValue) & tab & sanitize(roleDescriptionValue) & tab & sanitize(nameValue) & tab & sanitize(elementValue) & tab & sanitize(descriptionValue) & tab & enabledValue & linefeed
          end repeat
          return output
        end tell
      end tell
    end run
  `;

  const { stdout } = await runOsa(script, [processName, String(windowIndex)]);
  return stdout;
};

export const pasteAndSubmitText = async (appName: string, text: string): Promise<void> => {
  const escapedAppName = appName.replaceAll('"', '\\"');
  const script = `
    on run argv
      set previousClipboard to the clipboard
      set the clipboard to item 1 of argv
      tell application "${escapedAppName}" to activate
      delay 0.2
      tell application "System Events"
        keystroke "v" using command down
        key code 36
      end tell
      delay 0.1
      set the clipboard to previousClipboard
    end run
  `;

  await runOsa(script, [text]);
};

export const clickButtonByLabel = async (processName: string, windowIndex: number, label: string): Promise<void> => {
  await runOsa(clickButtonByLabelScript(), [processName, String(windowIndex), label]);
};

export const clickButtonByLabelScript = (): string => `
    on run argv
      set processName to item 1 of argv
      set windowIndex to (item 2 of argv) as integer
      set buttonLabel to item 3 of argv
      tell application "System Events"
        if not (exists process processName) then error "Process is not running: " & processName
        tell process processName
          set frontmost to true
          repeat with candidate in entire contents of window windowIndex
            try
              if role of candidate is "AXButton" then
                set candidateName to ""
                set candidateValue to ""
                set candidateDescription to ""
                try
                  set candidateName to name of candidate as text
                end try
                try
                  set candidateValue to value of candidate as text
                end try
                try
                  set candidateDescription to description of candidate as text
                end try
                if candidateName is buttonLabel or candidateValue is buttonLabel or candidateDescription is buttonLabel then
                  click candidate
                  return "clicked"
                end if
              end if
            end try
          end repeat
        end tell
      end tell
      error "Button not found: " & buttonLabel
    end run
  `;
