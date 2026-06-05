/** Código AR31 / F31 en PR500 → id de tabla P–T en herramientas. */
export function refrigerantIdFromPr500Code(code: number | undefined): string | null {
  switch (code) {
    case 1:
      return 'r134a';
    case 2:
      return 'r404a';
    case 3:
      return 'r22';
    case 4:
      return 'r410a';
    case 5:
      return 'r507a';
    default:
      return null;
  }
}

export function pr500RefrigerantLabel(code: number | undefined): string {
  const id = refrigerantIdFromPr500Code(code);
  if (!id) return 'Sin refrigerante configurado';
  const labels: Record<string, string> = {
    r134a: 'R134a',
    r404a: 'R404A',
    r22: 'R22',
    r410a: 'R410A',
    r507a: 'R507A',
  };
  return labels[id] ?? id;
}
