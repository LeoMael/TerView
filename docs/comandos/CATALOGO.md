# Catálogo de comandos (base de la Biblioteca de comandos)

Todos los comandos que vendrán incluidos en SSHorus, por categoría.
Al construir la función, este archivo se convierte en `src/features/commands/catalog.ts`.

**Leyenda:**
`{{nombre}}` = variable que la app pide (con sugerencias del servidor) ·
`{{nombre:valor}}` = variable con valor por defecto ·
⚠️ = peligroso (pide confirmación) · 🔒 = necesita `sudo` · 📊 = ideal para "Ejecutar y ver resultado"

---

## 1. Podman — contenedores

### Ver y estado
| Nombre | Comando | |
|--------|---------|---|
| Contenedores en ejecución | `podman ps` | 📊 |
| Todos los contenedores | `podman ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}"` | 📊 |
| Uso de recursos en vivo | `podman stats` | |
| Uso de recursos (una vez) | `podman stats --no-stream` | 📊 |
| Detalles de un contenedor | `podman inspect {{contenedor}}` | 📊 |
| Procesos dentro del contenedor | `podman top {{contenedor}}` | 📊 |
| Puertos publicados | `podman port {{contenedor}}` | 📊 |
| Información de Podman | `podman info` | 📊 |
| Versión | `podman version` | 📊 |
| Espacio usado | `podman system df` | 📊 |

### Levantar, parar, reiniciar
| Nombre | Comando | |
|--------|---------|---|
| Iniciar contenedor | `podman start {{contenedor}}` | |
| Detener contenedor | `podman stop {{contenedor}}` | |
| Reiniciar contenedor | `podman restart {{contenedor}}` | |
| Pausar / reanudar | `podman pause {{contenedor}}` / `podman unpause {{contenedor}}` | |
| Crear y levantar (en segundo plano) | `podman run -d --name {{nombre}} -p {{puerto_host}}:{{puerto_contenedor}} {{imagen}}` | |
| Levantar con reinicio automático | `podman run -d --restart=always --name {{nombre}} {{imagen}}` | |
| Levantar con carpeta compartida | `podman run -d --name {{nombre}} -v {{carpeta_host}}:{{carpeta_contenedor}}:Z {{imagen}}` | |
| Iniciar todos los detenidos | `podman start --all` | |
| Detener todos | `podman stop --all` | ⚠️ |

### Logs y entrar al contenedor
| Nombre | Comando | |
|--------|---------|---|
| Ver logs | `podman logs --tail {{lineas:200}} {{contenedor}}` | 📊 |
| Seguir logs en vivo | `podman logs -f --tail {{lineas:100}} {{contenedor}}` | |
| Logs desde hace un tiempo | `podman logs --since {{desde:1h}} {{contenedor}}` | 📊 |
| Entrar con shell | `podman exec -it {{contenedor}} {{shell:sh}}` | |
| Ejecutar un comando dentro | `podman exec {{contenedor}} {{comando}}` | 📊 |
| Copiar archivo al contenedor | `podman cp {{archivo}} {{contenedor}}:{{ruta}}` | |
| Copiar archivo desde el contenedor | `podman cp {{contenedor}}:{{ruta}} {{destino}}` | |

### Imágenes
| Nombre | Comando | |
|--------|---------|---|
| Listar imágenes | `podman images` | 📊 |
| Descargar imagen | `podman pull {{imagen}}` | |
| Construir imagen | `podman build -t {{nombre}}:{{etiqueta:latest}} {{carpeta:.}}` | |
| Etiquetar imagen | `podman tag {{imagen}} {{nueva_etiqueta}}` | |
| Subir imagen a registro | `podman push {{imagen}}` | |
| Iniciar sesión en registro | `podman login {{registro}}` | |
| Historial de una imagen | `podman history {{imagen}}` | 📊 |

### Compose (varios contenedores)
| Nombre | Comando | |
|--------|---------|---|
| Levantar proyecto | `podman compose up -d` | |
| Bajar proyecto | `podman compose down` | |
| Estado del proyecto | `podman compose ps` | 📊 |
| Logs del proyecto | `podman compose logs -f --tail {{lineas:100}}` | |
| Reconstruir y levantar | `podman compose up -d --build` | |
| Actualizar imágenes y levantar | `podman compose pull && podman compose up -d` | |

### Pods, volúmenes y redes
| Nombre | Comando | |
|--------|---------|---|
| Listar pods | `podman pod ps` | 📊 |
| Crear pod | `podman pod create --name {{pod}} -p {{puerto_host}}:{{puerto}}` | |
| Iniciar / detener pod | `podman pod start {{pod}}` / `podman pod stop {{pod}}` | |
| Listar volúmenes | `podman volume ls` | 📊 |
| Crear volumen | `podman volume create {{volumen}}` | |
| Detalles de volumen | `podman volume inspect {{volumen}}` | 📊 |
| Listar redes | `podman network ls` | 📊 |
| Crear red | `podman network create {{red}}` | |

### Arranque automático con systemd
| Nombre | Comando | |
|--------|---------|---|
| Generar servicio (Quadlet) | Crear `~/.config/containers/systemd/{{nombre}}.container` (asistente en la app) | |
| Recargar servicios de usuario | `systemctl --user daemon-reload` | |
| Activar servicio del contenedor | `systemctl --user enable --now {{nombre}}` | |
| Mantener servicios sin sesión iniciada | `loginctl enable-linger $USER` | 🔒 |
| Actualizar contenedores automáticamente | `podman auto-update` | |

### Limpieza
| Nombre | Comando | |
|--------|---------|---|
| Borrar contenedor | `podman rm {{contenedor}}` | ⚠️ |
| Borrar contenedor (forzado) | `podman rm -f {{contenedor}}` | ⚠️ |
| Borrar imagen | `podman rmi {{imagen}}` | ⚠️ |
| Borrar contenedores detenidos | `podman container prune -f` | ⚠️ |
| Borrar imágenes sin usar | `podman image prune -a -f` | ⚠️ |
| Limpieza total | `podman system prune -a -f` | ⚠️ |

---

## 2. Docker
Mismos comandos que Podman cambiando `podman` → `docker` (la app lo detecta según lo instalado).
Extras: `docker compose …`, `docker system df`, `sudo systemctl restart docker` 🔒.

---

## 3. Análisis del sistema (botón "Analizar servidor")
Todos son de solo lectura. 📊

| Qué | Comando |
|-----|---------|
| Sistema operativo | `cat /etc/os-release` |
| Kernel y arquitectura | `uname -a` |
| Nombre del equipo | `hostnamectl` |
| Tiempo encendido y carga | `uptime` |
| CPU | `lscpu` · `nproc` |
| Memoria y swap | `free -h` |
| Discos (uso) | `df -hT -x tmpfs -x devtmpfs` |
| Discos (dispositivos) | `lsblk` |
| Carpetas más pesadas | `du -h --max-depth=1 {{carpeta:/}} 2>/dev/null \| sort -hr \| head -20` |
| Procesos que más CPU usan | `ps aux --sort=-%cpu \| head -15` |
| Procesos que más memoria usan | `ps aux --sort=-%mem \| head -15` |
| Servicios fallidos | `systemctl --failed` |
| Puertos abiertos | `ss -tulpn` |
| Últimos errores del sistema | `journalctl -p err -n 50 --no-pager` |
| Últimos inicios de sesión | `last -n 20` |
| Usuarios conectados | `who` |
| Actualizaciones pendientes (Fedora/RHEL) | `dnf check-update` |
| Actualizaciones pendientes (Debian/Ubuntu) | `apt list --upgradable` |
| Contenedores | `podman ps -a` / `docker ps -a` |

---

## 4. Procesos
| Nombre | Comando | |
|--------|---------|---|
| Monitor interactivo | `htop` (o `top`) | |
| Buscar proceso | `ps aux \| grep -i {{nombre}}` | 📊 |
| Terminar proceso | `kill {{pid}}` | ⚠️ |
| Forzar cierre | `kill -9 {{pid}}` | ⚠️ |
| Árbol de procesos | `pstree -p` | 📊 |

## 5. Discos y archivos
| Nombre | Comando | |
|--------|---------|---|
| Espacio libre | `df -h` | 📊 |
| Tamaño de carpeta | `du -sh {{carpeta}}` | 📊 |
| Archivos más grandes | `find {{carpeta:/}} -type f -size +{{tamaño:100M}} -exec ls -lh {} \; 2>/dev/null` | 📊 |
| Buscar archivo por nombre | `find {{carpeta:.}} -iname "*{{nombre}}*"` | 📊 |
| Buscar texto en archivos | `grep -rn "{{texto}}" {{carpeta:.}}` | 📊 |
| Comprimir carpeta | `tar -czf {{archivo}}.tar.gz {{carpeta}}` | |
| Descomprimir | `tar -xzf {{archivo}}` | |

## 6. Red
| Nombre | Comando | |
|--------|---------|---|
| IPs del servidor | `ip -br addr` | 📊 |
| IP pública | `curl -s ifconfig.me` | 📊 |
| Probar conexión | `ping -c 4 {{host}}` | 📊 |
| Ruta hacia un host | `tracepath {{host}}` | 📊 |
| Puertos en uso | `ss -tulpn` | 📊 |
| ¿Quién usa un puerto? | `ss -tulpn \| grep :{{puerto}}` | 📊 |
| Probar una web | `curl -I {{url}}` | 📊 |
| DNS | `dig {{dominio}}` | 📊 |
| Firewall (Fedora/RHEL) | `sudo firewall-cmd --list-all` | 🔒 |
| Abrir puerto (Fedora/RHEL) | `sudo firewall-cmd --add-port={{puerto}}/tcp --permanent && sudo firewall-cmd --reload` | 🔒 |
| Firewall (Ubuntu) | `sudo ufw status verbose` | 🔒 |

## 7. Servicios (systemd)
| Nombre | Comando | |
|--------|---------|---|
| Estado de un servicio | `systemctl status {{servicio}}` | 📊 |
| Iniciar / detener / reiniciar | `sudo systemctl {{accion:restart}} {{servicio}}` | 🔒 |
| Activar al arrancar | `sudo systemctl enable --now {{servicio}}` | 🔒 |
| Servicios activos | `systemctl list-units --type=service --state=running` | 📊 |
| Logs de un servicio | `journalctl -u {{servicio}} -n {{lineas:100}} --no-pager` | 📊 |
| Logs en vivo | `journalctl -u {{servicio}} -f` | |

## 8. Logs
| Nombre | Comando | |
|--------|---------|---|
| Logs del sistema (hoy) | `journalctl --since today --no-pager \| tail -200` | 📊 |
| Errores recientes | `journalctl -p err -b --no-pager` | 📊 |
| Seguir un archivo de log | `tail -f {{archivo}}` | |
| Logs de nginx (errores) | `sudo tail -n 100 /var/log/nginx/error.log` | 🔒 📊 |

## 9. Usuarios y permisos
| Nombre | Comando | |
|--------|---------|---|
| Quién soy | `whoami && id` | 📊 |
| Crear usuario | `sudo useradd -m {{usuario}}` | 🔒 |
| Cambiar contraseña | `sudo passwd {{usuario}}` | 🔒 |
| Dar sudo (Fedora/RHEL) | `sudo usermod -aG wheel {{usuario}}` | 🔒 ⚠️ |
| Cambiar dueño | `sudo chown -R {{usuario}}:{{grupo}} {{ruta}}` | 🔒 ⚠️ |

## 10. Paquetes
| Nombre | Fedora/RHEL | Debian/Ubuntu |
|--------|-------------|---------------|
| Actualizar todo 🔒 | `sudo dnf upgrade -y` | `sudo apt update && sudo apt upgrade -y` |
| Instalar 🔒 | `sudo dnf install -y {{paquete}}` | `sudo apt install -y {{paquete}}` |
| Buscar | `dnf search {{paquete}}` | `apt search {{paquete}}` |
| Desinstalar 🔒 ⚠️ | `sudo dnf remove {{paquete}}` | `sudo apt remove {{paquete}}` |

## 11. Seguridad
| Nombre | Comando | |
|--------|---------|---|
| Intentos de acceso fallidos | `sudo journalctl -u sshd \| grep -i "failed" \| tail -50` | 🔒 📊 |
| Llaves SSH autorizadas | `cat ~/.ssh/authorized_keys` | 📊 |
| Estado de SELinux | `getenforce` | 📊 |
| Fail2ban | `sudo fail2ban-client status sshd` | 🔒 📊 |

## 12. Web (nginx / apache)
| Nombre | Comando | |
|--------|---------|---|
| Probar configuración nginx | `sudo nginx -t` | 🔒 📊 |
| Recargar nginx | `sudo systemctl reload nginx` | 🔒 |
| Certificados (certbot) | `sudo certbot certificates` | 🔒 📊 |
| Renovar certificados | `sudo certbot renew` | 🔒 |

## 13. Git
| Nombre | Comando | |
|--------|---------|---|
| Estado | `git status` | 📊 |
| Traer cambios | `git pull` | |
| Últimos commits | `git log --oneline -n {{n:15}}` | 📊 |
| Cambiar de rama | `git checkout {{rama}}` | |
