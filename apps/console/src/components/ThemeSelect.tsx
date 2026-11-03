import { useThemeChoice, type ThemeChoice } from '@/theme/useTheme';

export function ThemeSelect() {
  const [choice, setChoice] = useThemeChoice();
  return (
    <label className="row">
      <span className="sr-only">Theme</span>
      <select
        className="select"
        value={choice}
        onChange={(event) => setChoice(event.target.value as ThemeChoice)}
      >
        <option value="system">System theme</option>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
    </label>
  );
}
