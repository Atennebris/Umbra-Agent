import React from 'react';

interface ButtonProps {
  label: string;
  onClick: () => void;
}

export function Button({ label, onClick }: ButtonProps) {
  return <button onClick={onClick}>{label}</button>;
}

export class WidgetManager {
  private widgets: string[] = [];

  add(name: string) {
    this.widgets.push(name);
  }
}
