// Salidas falsas de los comandos que la app ejecuta por su cuenta (exec) en el servidor simulado.
// Se busca la primera regla cuyo patrón aparezca en el comando.

export type Rule = [RegExp, string | (() => string)];

// Reglas de cada función en ./salidas/*.ts (cada archivo exporta `reglas`). Primero las propias.
const MAS = import.meta.glob<Rule[]>("./salidas/*.ts", { eager: true, import: "reglas" });

const RULES: Rule[] = [
  ...Object.values(MAS).flat(),
  // Quién es el usuario y si tiene sudo (features/privileges/detect.ts): sudo sin contraseña.
  [
    /echo "tv_begin=1"/,
    "tv_begin=1\nuid=1000\nuser=deploy\ngroups=deploy sudo docker\nsudo=1\nsudo_nopasswd=1\ndoas=0\nos_id=ubuntu\nos_like=debian\ntv_end=1\n",
  ],
];

export function execOutput(command: string): string | null {
  for (const [re, out] of RULES) if (re.test(command)) return typeof out === "function" ? out() : out;
  return null;
}
