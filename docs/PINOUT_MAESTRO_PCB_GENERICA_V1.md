# PINOUT Maestro PCB Generica v1

Objetivo: usar una sola PCB base para la familia de controladores:
- PR500 (presion)
- Combistato 2 sondas
- Combistato 1 sonda

## MCU base

- Modulo: `ESP32-WROOM-32`
- Programacion/servicio:
  - `GPIO1` -> TX0 (TTL)
  - `GPIO3` -> RX0 (TTL)
  - `EN` -> RESET
  - `GPIO0` -> BOOT

## Bus y perifericos comunes

- I2C principal (reservado para ADC externos y expansion):
  - `GPIO21` -> SDA
  - `GPIO22` -> SCL

- ADC externos (opcional por modelo):
  - `ADS1115 #1` -> direccion `0x48`
  - `ADS1115 #2` -> direccion `0x49`
  - Nota: ADDR de cada ADS1115 debe cablearse para evitar conflicto.

## Interfaz de usuario

- Display `TM1637`:
  - `GPIO18` -> CLK
  - `GPIO19` -> DIO

- Botones:
  - `GPIO13` -> UP
  - `GPIO14` -> DOWN
  - `GPIO16` -> SET
  - `GPIO17` -> ESC/MANUAL

## Actuadores

- Reles:
  - `GPIO25` -> Rele 1 (compresor principal)
  - `GPIO26` -> Rele 2 (ventilador o etapa 2)
  - `GPIO27` -> Rele 3 (deshielo o etapa 3)

## Entradas analogicas recomendadas por producto

- PR500:
  - Presion por ADS1115 (canal dedicado) o ADC interno segun hardware final.

- Combistato 2 sondas:
  - S1 y S2 por ADS1115 (2 canales).

- Combistato 1 sonda:
  - S1 por ADS1115 (1 canal). S2 no se usa.

## Reglas de diseno para escalar

- Mantener `GPIO21/22` exclusivos para I2C.
- Evitar usar `GPIO1/3/0` en logica de campo (solo servicio/boot).
- Definir jumpers o resistencias opcionales para variantes de placa:
  - sin display
  - sin segundo ADS1115
  - sin tercer rele
- Mantener pinout de conectores estable entre modelos para simplificar produccion.

## Matriz rapida de uso

- Base comun en todos: ESP32 + botones + 3 reles + I2C.
- Diferencia por firmware:
  - PR500: control por presion.
  - 2 sondas: control por S1/S2.
  - 1 sonda: control por S1.

