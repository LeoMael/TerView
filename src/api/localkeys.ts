import { call } from "./core";

/** Llave pública de ~/.ssh de este equipo. */
export interface LocalPublicKey {
  path: string;
  /** Privada correspondiente (el .pub sin extensión), si existe. */
  privatePath: string | null;
  line: string;
}

export interface GeneratedKey {
  privatePath: string;
  publicPath: string;
  publicLine: string;
}

/** Llaves SSH LOCALES (~/.ssh). La privada nunca sale del equipo: solo se devuelve su ruta. */
export const localkeys = {
  listPublic: () => call<LocalPublicKey[]>("local_ssh_public_keys"),
  /** Crea ~/.ssh/<name> (ed25519, 0600) y <name>.pub. Falla si ya existen. */
  generate: (name: string, comment: string, passphrase: string) =>
    call<GeneratedKey>("local_ssh_generate_key", { name, comment, passphrase: passphrase || null }),
};
