/*
 * Motor de cálculo de adherencia (PDC) y persistencia (Kaplan-Meier) al TAR.
 * Implementa ESPECIFICACION_METODOLOGIA.md (v1.0).
 *
 * Funciona en el navegador (window.MotorTAR) y en Node (module.exports).
 * Todas las fechas se manejan internamente como "día" = nº entero de días desde 1970-01-01 (UTC).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MotorTAR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MS_DIA = 86400000;
  const DIAS_MES = 30.4375;
  const LAVADO_NAIVE_MIN = 4; // meses de lavado mínimos para poder identificar pacientes naive

  const COL = {
    fecha: 'Fecha Dispensación',
    id: 'Id',
    patologia: 'Patología',
    codProducto: 'Código Producto Dispensado',
    producto: 'Descripción Producto Dispensado',
    cantidad: 'Cantidad',
    posologia: 'Posología (Según Prescripción)',
    servicio: 'Servicio Prescriptor',
    codGrupo: 'Código Grupo Terapéutico',
    descGrupo: 'Descripción Grupo Terapéutico',
    pa: 'Descripción Principio Activo',
    coste: 'Coste Dispensación',
    cpa: 'Código servicio CPA',
    codDpto: 'Código dpto referencia',
    descDpto: 'Descripción dpto referencia'
  };

  const DEFECTO = {
    modo: 'pa',            // 'pa' | 'producto' | 'tar'
    elementos: [],
    desde: null,
    hasta: null,
    lavadoMeses: 4,
    gracia: 90,
    umbral: 90,
    pdcMinDias: 120,
    umbralMPR: 110,        // % a partir del cual se sospecha acumulación
    umbralSobrante: 30,    // días de medicación sobrante al final del periodo
    umbralAdelanto: 10,    // días de adelanto para contar una recogida como anticipada
    cohorte: 'todos',      // 'todos' | 'naive' | 'pretratado'
    filtros: {},           // { servicio: [], dpto: [], patologia: [] }
    minEnRiesgo: 10,
    prefijoATC: 'J05A'
  };

  // ============================================================
  // Fechas
  // ============================================================
  function aDia(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) {
      if (isNaN(v)) return null;
      // Redondeo al día más cercano en hora local (evita el desfase de algunas lecturas de Excel)
      return Math.round((v.getTime() - v.getTimezoneOffset() * 60000) / MS_DIA);
    }
    if (typeof v === 'number') {
      if (!isFinite(v)) return null;
      return Math.floor(v) - 25569; // nº de serie Excel -> días desde 1970-01-01
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
    if (m) return Math.round(Date.UTC(+m[3], +m[2] - 1, +m[1]) / MS_DIA);
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / MS_DIA);
    if (/^\d+(\.\d+)?$/.test(s)) return aDia(parseFloat(s));
    return null;
  }
  function diaAISO(d) {
    if (d === null || d === undefined) return null;
    return new Date(d * MS_DIA).toISOString().slice(0, 10);
  }
  function diaATexto(d) {
    const iso = diaAISO(d);
    return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '';
  }
  function sumarMeses(dia, n) {
    const f = new Date(dia * MS_DIA);
    f.setUTCMonth(f.getUTCMonth() + n);
    return Math.round(f.getTime() / MS_DIA);
  }

  // ============================================================
  // Números y texto
  // ============================================================
  function aNumero(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = String(v).trim().replace(/\s|€/g, '');
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(',', '.');
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  }
  const txt = v => (v === null || v === undefined) ? '' : String(v).trim();

  // ============================================================
  // Posología
  // ============================================================
  const RX_FASE = /^\s*(?:(\d+(?:[.,]\d+)?)\s+y\s+MEDIO|(\d+(?:[.,]\d+)?)|MEDIO)\s+(.+?)\s+cada\s+(?:(\d+(?:[.,]\d+)?)\s+)?(d[ií]as?|d[ií]a\/s|horas?|semanas?|mes(?:es)?)(?![a-zñ])(.*)$/i;
  const RX_DURANTE = /durante\s+(\d+(?:[.,]\d+)?)\s*(d[ií]as?|d[ií]a\/s|semanas?|mes(?:es)?)/i;

  function diasDeUnidad(u) {
    u = u.toLowerCase();
    if (u.startsWith('hora')) return 1 / 24;
    if (u.startsWith('semana')) return 7;
    if (u.startsWith('mes')) return 30;
    return 1;
  }

  /**
   * Devuelve { fases: [{ upd, duracion }] } (upd = unidades por día; duracion en días o null = indefinida)
   * o null si no se puede interpretar.
   */
  function parsePosologia(str) {
    if (!str || typeof str !== 'string') return null;
    const partes = str.trim().split(/\s+a\s+continuaci[oó]n\s+/i);
    const fases = [];
    for (const p of partes) {
      const m = p.match(RX_FASE);
      if (!m) return null;
      let n;
      if (m[1] !== undefined) n = parseFloat(m[1].replace(',', '.')) + 0.5;
      else if (m[2] !== undefined) n = parseFloat(m[2].replace(',', '.'));
      else n = 0.5;
      const unidadForma = m[3].trim();
      if (/^envase/i.test(unidadForma)) return null; // no convertible a unidades de administración
      const x = m[4] !== undefined ? parseFloat(m[4].replace(',', '.')) : 1;
      const intervalo = x * diasDeUnidad(m[5]);
      if (!(n > 0) || !(intervalo > 0)) return null;
      let duracion = null;
      const d = m[6].match(RX_DURANTE);
      if (d) duracion = parseFloat(d[1].replace(',', '.')) * diasDeUnidad(d[2]);
      fases.push({ upd: n / intervalo, duracion });
    }
    return fases.length ? { fases } : null;
  }

  /**
   * Días de suministro de `cantidad` unidades, empezando a consumir en el día `transcurrido`
   * (días desde la primera dispensación de ese producto al paciente). La última fase es indefinida.
   */
  function diasSuministro(pos, cantidad, transcurrido = 0) {
    if (!pos || !(cantidad > 0)) return null;
    const fases = pos.fases;
    let ini = 0, i = 0;
    // Localizar la fase vigente
    while (i < fases.length - 1 && fases[i].duracion !== null && transcurrido >= ini + fases[i].duracion) {
      ini += fases[i].duracion;
      i++;
    }
    let t = transcurrido, restante = cantidad;
    while (true) {
      const f = fases[i];
      const ultima = i === fases.length - 1 || f.duracion === null;
      const fin = ultima ? Infinity : ini + f.duracion;
      const capacidad = (fin - t) * f.upd;
      if (restante <= capacidad) { t += restante / f.upd; break; }
      restante -= capacidad;
      t = fin; ini = fin; i++;
    }
    return Math.max(1, Math.round(t - transcurrido));
  }

  // ============================================================
  // Depuración
  // ============================================================
  function depurar(filas, cfg = {}) {
    const prefijo = (cfg.prefijoATC || DEFECTO.prefijoATC).toUpperCase();
    const inf = {
      filasLeidas: filas.length, sinFechaOId: 0, duplicados: 0, noTAR: 0,
      devoluciones: 0, devolucionesNoAplicadas: 0, unidadesDevueltasNoAplicadas: 0,
      filasAnuladasPorDevolucion: 0, posologiaRespaldo: 0, posologiaNoInterpretable: 0,
      cantidadCero: 0, dptoCompletado: 0
    };
    const avisos = [];
    const noInterpretables = new Map(); // texto -> nº de filas

    // 1) Normalizar + duplicados exactos
    const vistos = new Set();
    const norm = [];
    filas.forEach((r, i) => {
      const clave = JSON.stringify(Object.keys(COL).map(k => r[COL[k]] instanceof Date ? r[COL[k]].getTime() : r[COL[k]]));
      if (vistos.has(clave)) { inf.duplicados++; return; }
      vistos.add(clave);
      const dia = aDia(r[COL.fecha]);
      const id = txt(r[COL.id]);
      if (dia === null || !id) { inf.sinFechaOId++; return; }
      const codGrupo = txt(r[COL.codGrupo]).toUpperCase();
      if (!codGrupo.startsWith(prefijo)) { inf.noTAR++; return; }
      norm.push({
        fila: i + 2, dia, id,
        patologia: txt(r[COL.patologia]),
        codProducto: txt(r[COL.codProducto]),
        producto: txt(r[COL.producto]),
        cantidad: aNumero(r[COL.cantidad]) || 0,
        cantidadOriginal: aNumero(r[COL.cantidad]) || 0,
        posologia: txt(r[COL.posologia]),
        servicio: txt(r[COL.servicio]),
        codGrupo,
        descGrupo: txt(r[COL.descGrupo]),
        pa: txt(r[COL.pa]),
        coste: aNumero(r[COL.coste]),
        cpa: txt(r[COL.cpa]),
        codDpto: txt(r[COL.codDpto]),
        descDpto: txt(r[COL.descDpto])
      });
    });

    // 2) Descripción de departamento ausente -> la más frecuente de su código
    const dptoFrec = {};
    norm.forEach(d => {
      if (d.codDpto && d.descDpto) {
        const m = (dptoFrec[d.codDpto] = dptoFrec[d.codDpto] || {});
        m[d.descDpto] = (m[d.descDpto] || 0) + 1;
      }
    });
    norm.forEach(d => {
      if (!d.descDpto && d.codDpto && dptoFrec[d.codDpto]) {
        d.descDpto = Object.entries(dptoFrec[d.codDpto]).sort((a, b) => b[1] - a[1])[0][0];
        inf.dptoCompletado++;
      }
    });

    // 3) Devoluciones: restar de la dispensación positiva más reciente (mismo paciente y producto)
    const porPacProd = {};
    const devoluciones = new Map(); // id -> devoluciones (para el histórico del paciente)
    norm.forEach(d => { (porPacProd[d.id + '|' + d.codProducto] = porPacProd[d.id + '|' + d.codProducto] || []).push(d); });
    Object.values(porPacProd).forEach(lista => {
      lista.sort((a, b) => a.dia - b.dia || b.cantidad - a.cantidad);
      lista.forEach((d, k) => {
        if (d.cantidad >= 0) return;
        inf.devoluciones++;
        let destino = null;
        for (let j = k - 1; j >= 0; j--) if (lista[j].cantidad > 0 && lista[j].dia <= d.dia) { destino = lista[j]; break; }
        if (!destino) {
          inf.devolucionesNoAplicadas++;
          inf.unidadesDevueltasNoAplicadas += -d.cantidad;
        } else {
          const aplicar = Math.min(destino.cantidad, -d.cantidad);
          destino.cantidad -= aplicar;
          if (destino.coste !== null && d.coste !== null) destino.coste += d.coste;
          if (aplicar < -d.cantidad) inf.unidadesDevueltasNoAplicadas += -d.cantidad - aplicar;
          if (destino.cantidad === 0) inf.filasAnuladasPorDevolucion++;
        }
        if (!devoluciones.has(d.id)) devoluciones.set(d.id, []);
        devoluciones.get(d.id).push({ dia: d.dia, producto: d.producto, pa: d.pa, cantidad: d.cantidadOriginal, coste: d.coste, aplicadaA: destino ? destino.dia : null });
        d.cantidad = 0;
        d._devolucion = true;
      });
    });
    const positivas = norm.filter(d => {
      if (d._devolucion) return false;
      if (d.cantidad <= 0) { if (d.cantidadOriginal === 0) inf.cantidadCero++; return false; }
      return true;
    });

    // 4) Posología: interpretar; respaldo = posología más frecuente del producto
    const frecPos = {};
    positivas.forEach(d => {
      d._pos = parsePosologia(d.posologia);
      if (d._pos) {
        const m = (frecPos[d.codProducto] = frecPos[d.codProducto] || {});
        m[d.posologia] = (m[d.posologia] || 0) + 1;
      }
    });
    const respaldo = {};
    Object.entries(frecPos).forEach(([cod, m]) => {
      const txtPos = Object.entries(m).sort((a, b) => b[1] - a[1])[0][0];
      respaldo[cod] = { texto: txtPos, pos: parsePosologia(txtPos) };
    });

    // 5) Días de suministro (fase vigente según días desde la 1ª dispensación del producto)
    const primeraProd = {};
    positivas.sort((a, b) => a.dia - b.dia);
    positivas.forEach(d => {
      const k = d.id + '|' + d.codProducto;
      if (primeraProd[k] === undefined) primeraProd[k] = d.dia;
    });
    const disps = [];
    positivas.forEach(d => {
      let pos = d._pos;
      d.posologiaUsada = d.posologia;
      if (!pos) {
        if (respaldo[d.codProducto]) {
          pos = respaldo[d.codProducto].pos;
          d.posologiaUsada = respaldo[d.codProducto].texto;
          d.posologiaRespaldo = true;
          inf.posologiaRespaldo++;
        } else {
          inf.posologiaNoInterpretable++;
          noInterpretables.set(d.posologia, (noInterpretables.get(d.posologia) || 0) + 1);
          return;
        }
      }
      d.suministro = diasSuministro(pos, d.cantidad, d.dia - primeraProd[d.id + '|' + d.codProducto]);
      delete d._pos;
      disps.push(d);
    });

    // Índice por paciente
    const porPaciente = new Map();
    disps.forEach(d => {
      if (!porPaciente.has(d.id)) porPaciente.set(d.id, []);
      porPaciente.get(d.id).push(d);
    });
    porPaciente.forEach(l => l.sort((a, b) => a.dia - b.dia));

    let fechaMin = null, fechaMax = null;
    disps.forEach(d => {
      if (fechaMin === null || d.dia < fechaMin) fechaMin = d.dia;
      if (fechaMax === null || d.dia > fechaMax) fechaMax = d.dia;
    });

    if (inf.posologiaRespaldo) avisos.push(`${inf.posologiaRespaldo} dispensaciones con posología no interpretable: se ha usado la posología más frecuente del producto.`);
    if (inf.posologiaNoInterpretable) avisos.push(`${inf.posologiaNoInterpretable} dispensaciones excluidas: posología no interpretable y sin posología de respaldo para el producto.`);
    if (inf.devolucionesNoAplicadas) avisos.push(`${inf.devolucionesNoAplicadas} devoluciones sin dispensación previa del mismo producto: descartadas.`);

    inf.dispensacionesValidas = disps.length;
    inf.pacientes = porPaciente.size;
    inf.posologiasNoInterpretables = [...noInterpretables.entries()].map(([texto, n]) => ({ texto, n })).sort((a, b) => b.n - a.n);
    devoluciones.forEach(l => l.sort((a, b) => a.dia - b.dia));
    return { disps, porPaciente, devoluciones, fechaMin, fechaMax, informe: inf, avisos };
  }

  // ============================================================
  // Opciones para la interfaz
  // ============================================================
  function contarValores(disps, campo) {
    const m = new Map();
    disps.forEach(d => {
      const v = d[campo];
      if (!v) return;
      if (!m.has(v)) m.set(v, new Set());
      m.get(v).add(d.id);
    });
    return [...m.entries()].map(([valor, s]) => ({ valor, pacientes: s.size })).sort((a, b) => b.pacientes - a.pacientes || a.valor.localeCompare(b.valor));
  }
  function opciones(datos) {
    const { disps } = datos;
    return {
      pa: contarValores(disps, 'pa'),
      producto: contarValores(disps, 'producto'),
      servicio: contarValores(disps, 'servicio'),
      dpto: contarValores(disps, 'descDpto'),
      patologia: contarValores(disps, 'patologia'),
      fechaMin: datos.fechaMin,
      fechaMax: datos.fechaMax
    };
  }

  // ============================================================
  // Cobertura
  // ============================================================
  const claveDe = (d, modo) => modo === 'producto' ? d.producto : modo === 'tar' ? 'TAR' : d.pa;

  /** Intervalos de cobertura de una secuencia con desplazamiento de solapamientos. */
  function intervalosSecuencia(disps) {
    const out = [];
    let cursor = -Infinity;
    disps.forEach(d => {
      const ini = Math.max(d.dia, cursor);
      const fin = ini + d.suministro - 1;
      out.push({ ini, fin, dia: d.dia, suministro: d.suministro });
      cursor = fin + 1;
    });
    return out;
  }
  /** Une intervalos en bloques continuos disjuntos. */
  function fusionar(intervalos) {
    const s = [...intervalos].sort((a, b) => a.ini - b.ini);
    const bloques = [];
    s.forEach(iv => {
      const u = bloques[bloques.length - 1];
      if (u && iv.ini <= u.fin + 1) {
        u.fin = Math.max(u.fin, iv.fin);
        u.ultimaDisp = Math.max(u.ultimaDisp, iv.dia);
      } else bloques.push({ ini: iv.ini, fin: iv.fin, ultimaDisp: iv.dia });
    });
    return bloques;
  }
  function bloquesCobertura(eDisps, modo) {
    if (modo !== 'tar') return fusionar(intervalosSecuencia(eDisps));
    // Cualquier TAR: cobertura por principio activo y unión
    const porPA = {};
    eDisps.forEach(d => { (porPA[d.pa] = porPA[d.pa] || []).push(d); });
    let todos = [];
    Object.values(porPA).forEach(l => { todos = todos.concat(intervalosSecuencia(l)); });
    return fusionar(todos);
  }
  function diasCubiertos(bloques, a, b) {
    let n = 0;
    bloques.forEach(bl => {
      const i = Math.max(a, bl.ini), f = Math.min(b, bl.fin);
      if (f >= i) n += f - i + 1;
    });
    return n;
  }

  // ============================================================
  // Historia de un paciente para un elemento
  // ============================================================
  function historia(dispsPac, elemento, P) {
    const modo = P.modo;
    const eDisps = modo === 'tar' ? dispsPac : dispsPac.filter(d => claveDe(d, modo) === elemento);
    if (!eDisps.length) return null;
    const bloques = bloquesCobertura(eDisps, modo);

    // Días de dispensación por elemento (para decidir si un elemento es "nuevo")
    const diasPorClave = {};
    if (modo !== 'tar') dispsPac.forEach(d => { const k = claveDe(d, modo); (diasPorClave[k] = diasPorClave[k] || []).push(d.dia); });
    const esNuevo = (k, S) => {
      // Ventana de "elemento nuevo": mínimo 4 meses aunque el lavado se reduzca, para que un fármaco
      // que se toma a la vez (p. ej. FTC/TAF con DTG, cada 90 días) no se confunda con un cambio.
      const desdeLav = sumarMeses(S, -Math.max(LAVADO_NAIVE_MIN, P.lavadoMeses));
      return !diasPorClave[k].some(x => x >= desdeLav && x < S);
    };

    bloques.forEach((b, i) => {
      const sig = bloques[i + 1];
      b.sigIni = sig ? sig.ini : null;
      b.hueco = sig ? sig.ini - b.fin - 1 : null;
      b.cambio = null;
      if (modo === 'tar') return;
      if (sig && b.hueco <= P.gracia) return; // sigue con el elemento
      const tope = sig ? sig.ini - 1 : P.hasta;
      for (const d of dispsPac) {
        if (d.dia <= b.ultimaDisp) continue;
        if (d.dia > tope) break;
        const k = claveDe(d, modo);
        if (b.cambio && d.dia > b.cambio.S) break;
        if (k !== elemento && esNuevo(k, d.dia)) {
          // Todos los elementos nuevos que empiezan el mismo día forman el destino (p. ej. CAB + RPV)
          if (!b.cambio) b.cambio = { S: d.dia, destinos: [] };
          if (!b.cambio.destinos.includes(k)) b.cambio.destinos.push(k);
        }
      }
      if (b.cambio) b.cambio.destino = b.cambio.destinos.sort().join(' + ');
    });

    // Tramos de tratamiento (se cierran en un cambio; se reabren si el elemento vuelve)
    const tramos = [];
    let cur = { ini: bloques[0].ini };
    bloques.forEach(b => {
      if (!cur) cur = { ini: b.ini };
      if (b.cambio) {
        cur.fin = b.cambio.S - 1;
        cur.cambio = b.cambio;
        tramos.push(cur);
        cur = null;
      }
    });
    if (cur) { cur.fin = P.hasta; tramos.push(cur); }

    // Adherencia (PDC / MPR / sobrante / adelantos): SOLO con las dispensaciones de la ventana
    // (dia >= Desde). No se arrastra medicación de dispensaciones anteriores a "Desde".
    // En Cualquier TAR, un "día de dispensación" aporta el mayor suministro de los productos
    // dispensados ese día (evita sumar componentes).
    const eVentana = eDisps.filter(d => d.dia >= P.desde);
    const bloquesVentana = eVentana.length ? bloquesCobertura(eVentana, modo) : [];
    let secuencia = [];
    if (eVentana.length) {
      if (modo !== 'tar') secuencia = intervalosSecuencia(eVentana);
      else {
        const porDia = new Map();
        eVentana.forEach(d => porDia.set(d.dia, Math.max(porDia.get(d.dia) || 0, d.suministro)));
        secuencia = intervalosSecuencia([...porDia.entries()].sort((a, b) => a[0] - b[0]).map(([dia, suministro]) => ({ dia, suministro })));
      }
    }

    const primerDia = eDisps[0].dia;
    return { eDisps, eVentana, bloques, bloquesVentana, tramos, primerDia, secuencia };
  }

  function clasificar(h, dispsPac, P) {
    if (h.primerDia >= P.desde) {
      const previo = dispsPac.some(d => d.dia < h.primerDia);
      return previo ? 'pretratado' : 'naive';
    }
    // Estable: ya recibía el elemento antes de Desde y tiene al menos una dispensación en la ventana
    return h.eVentana.length ? 'estable' : null;
  }

  function filaReferencia(h, P) {
    return h.eDisps.find(d => d.dia >= P.desde) || h.eDisps[h.eDisps.length - 1];
  }

  function pasaFiltros(ref, filtros) {
    if (!filtros) return true;
    const chk = (lista, v) => !lista || !lista.length || lista.includes(v);
    return chk(filtros.servicio, ref.servicio) && chk(filtros.dpto, ref.descDpto) && chk(filtros.patologia, ref.patologia) && chk(filtros.id, ref.id);
  }

  function tratamientoPrevio(dispsPac, h, P) {
    for (let i = dispsPac.length - 1; i >= 0; i--) {
      const d = dispsPac[i];
      if (d.dia < h.primerDia && claveDe(d, P.modo) !== claveDe(h.eDisps[0], P.modo)) return { dia: d.dia, elemento: claveDe(d, P.modo) };
    }
    return null;
  }

  // ============================================================
  // PDC
  // ============================================================
  /*
   * Periodo de cada tramo:
   *  - tramo cerrado por un cambio: hasta el día anterior al cambio (S − 1);
   *  - último tramo (sin cambio): hasta el día anterior a la última dispensación del elemento
   *    dentro de la ventana. Lo dispensado ese día no se cuenta, porque no se sabe cuándo volverá.
   */
  function pdcPaciente(h, cohorte, P) {
    // El periodo empieza en la primera dispensación del elemento dentro de la ventana (todas las cohortes)
    const inicio = h.eVentana.length ? h.eVentana[0].dia : h.primerDia;
    let dias = 0, cubiertos = 0, fin = null, cambio = null, ultimaDisp = null;
    let disponible = 0, sobrante = 0, nAdelantos = 0, maxAdelanto = 0, diasMPR = 0;
    h.tramos.forEach(t => {
      const a = Math.max(t.ini, inicio);
      let b, porCambio = false;
      if (t.cambio && t.cambio.S <= P.hasta) { b = t.cambio.S - 1; porCambio = true; }
      else {
        const ult = h.eDisps.filter(d => d.dia >= a && d.dia <= Math.min(t.fin, P.hasta)).pop();
        if (!ult) return;
        ultimaDisp = ult.dia;
        b = ult.dia - 1;
      }
      b = Math.min(b, P.hasta);
      if (b < a) return;
      dias += b - a + 1;
      cubiertos += diasCubiertos(h.bloquesVentana, a, b);
      fin = b;
      // MPR / sobrante se miden en la ÚLTIMA RECOGIDA del elemento en el tramo: periodo [a, última − 1]
      // y suministro sin esa última dispensación. En un tramo que acaba en cambio, así no se confunde
      // con acumulación la medicación que le quedaba al cambiar.
      let bM = b; // último tramo: b ya es el día anterior a la última recogida
      if (porCambio) {
        const ultE = h.secuencia.filter(iv => iv.dia >= a && iv.dia <= b).pop();
        bM = ultE ? ultE.dia - 1 : a - 1;
      }
      if (bM >= a) {
        let disp = 0;
        h.secuencia.forEach(iv => {
          if (iv.dia >= a && iv.dia <= bM) disp += iv.suministro;
        });
        diasMPR += bM - a + 1;
        disponible += disp;
        sobrante += Math.max(0, disp - diasCubiertos(h.bloquesVentana, a, bM));
      }
      // Adelanto = días de medicación que aún le quedaban al recoger (incluye la última recogida)
      h.secuencia.forEach(iv => {
        if (iv.dia >= a && iv.dia <= b + 1) {
          const adel = iv.ini - iv.dia;
          if (adel >= P.umbralAdelanto) nAdelantos++;
          if (adel > maxAdelanto) maxAdelanto = adel;
        }
      });
      if (t.cambio && !cambio && t.cambio.S <= P.hasta) cambio = { dia: t.cambio.S, destino: t.cambio.destino };
    });
    const mpr = diasMPR > 0 ? disponible / diasMPR * 100 : null;
    return {
      inicio, fin, dias, cubiertos, pdc: dias > 0 ? cubiertos / dias * 100 : null, cambio, ultimaDisp,
      disponible, diasMPR, mpr, sobrante, nAdelantos, maxAdelanto,
      alertaAcumulacion: mpr !== null && (mpr > P.umbralMPR || sobrante >= P.umbralSobrante)
    };
  }

  // ============================================================
  // Persistencia
  // ============================================================
  function persistenciaPaciente(h, P) {
    const t0 = h.primerDia;
    for (const b of h.bloques) {
      const huecoDeclarado = b.sigIni !== null ? b.hueco > P.gracia : (P.hasta - b.fin > P.gracia);
      if (b.cambio && b.cambio.S - 1 - b.fin <= P.gracia) {
        const f = b.cambio.S - 1;
        return { tiempo: f - t0, evento: 1, motivo: 'cambio', fechaFin: f, destino: b.cambio.destino };
      }
      if (huecoDeclarado) {
        return { tiempo: b.fin - t0, evento: 1, motivo: 'hueco', fechaFin: b.fin, destino: b.cambio ? b.cambio.destino : null };
      }
    }
    return { tiempo: P.hasta - t0, evento: 0, motivo: 'censura', fechaFin: P.hasta, destino: null };
  }

  // ============================================================
  // Kaplan-Meier (Greenwood, IC 95 % log-log)
  // ============================================================
  function kaplanMeier(sujetos, z = 1.96) {
    const v = sujetos.filter(s => s.tiempo >= 0);
    const n = v.length;
    const pasos = [{ t: 0, surv: 1, enRiesgo: n, eventos: 0, censuras: 0, ciL: 1, ciU: 1 }];
    if (!n) return { n: 0, pasos, mediana: null, medianaAlcanzada: false };
    const tiempos = [...new Set(v.filter(s => s.evento === 1).map(s => s.tiempo))].sort((a, b) => a - b);
    let surv = 1, suma = 0;
    tiempos.forEach(t => {
      const enRiesgo = v.filter(s => s.tiempo >= t).length;
      const d = v.filter(s => s.evento === 1 && s.tiempo === t).length;
      surv *= 1 - d / enRiesgo;
      suma = enRiesgo - d > 0 ? suma + d / (enRiesgo * (enRiesgo - d)) : Infinity;
      let ciL = surv, ciU = surv;
      if (surv > 0 && surv < 1 && isFinite(suma) && suma > 0) {
        const lnS = Math.log(surv);
        const se = Math.sqrt(suma) / Math.abs(lnS);
        const c = Math.log(-lnS);
        ciU = Math.exp(-Math.exp(c - z * se));
        ciL = Math.exp(-Math.exp(c + z * se));
      } else if (surv <= 0) { ciL = 0; ciU = 0; }
      pasos.push({ t, surv, enRiesgo, eventos: d, ciL, ciU });
    });
    let mediana = null;
    for (const p of pasos) if (p.surv <= 0.5) { mediana = p.t; break; }
    const censuras = v.filter(s => s.evento === 0).map(s => ({ t: s.tiempo, surv: survEn(pasos, s.tiempo) }));
    return { n, pasos, mediana, medianaAlcanzada: mediana !== null, censuras };
  }
  function estadoEn(pasos, t) {
    let r = pasos[0];
    for (const p of pasos) { if (p.t <= t) r = p; else break; }
    return r;
  }
  function survEn(pasos, t) { return estadoEn(pasos, t).surv; }
  function enRiesgoEn(sujetos, t) { return sujetos.filter(s => s.tiempo >= t).length; }

  // ============================================================
  // Log-rank (k grupos) y chi-cuadrado
  // ============================================================
  function logRank(grupos) {
    const k = grupos.length;
    if (k < 2) return null;
    const todos = [];
    grupos.forEach((g, gi) => g.forEach(s => todos.push({ ...s, g: gi })));
    const tiempos = [...new Set(todos.filter(s => s.evento === 1).map(s => s.tiempo))].sort((a, b) => a - b);
    const O = new Array(k).fill(0), E = new Array(k).fill(0);
    const V = Array.from({ length: k }, () => new Array(k).fill(0));
    tiempos.forEach(t => {
      const nj = grupos.map(g => g.filter(s => s.tiempo >= t).length);
      const dj = grupos.map(g => g.filter(s => s.evento === 1 && s.tiempo === t).length);
      const N = nj.reduce((a, b) => a + b, 0), D = dj.reduce((a, b) => a + b, 0);
      if (N === 0) return;
      for (let i = 0; i < k; i++) {
        O[i] += dj[i];
        E[i] += D * nj[i] / N;
        if (N > 1) for (let j = 0; j < k; j++) {
          V[i][j] += (i === j)
            ? D * (nj[i] / N) * (1 - nj[i] / N) * (N - D) / (N - 1)
            : -D * (nj[i] / N) * (nj[j] / N) * (N - D) / (N - 1);
        }
      }
    });
    // Estadístico con los k-1 primeros grupos
    const m = k - 1;
    const U = O.slice(0, m).map((o, i) => o - E[i]);
    const Vr = V.slice(0, m).map(f => f.slice(0, m));
    const inv = invertir(Vr);
    if (!inv) return { chi2: null, gl: m, p: null, O, E };
    let chi2 = 0;
    for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) chi2 += U[i] * inv[i][j] * U[j];
    return { chi2, gl: m, p: 1 - chi2CDF(chi2, m), O, E };
  }
  function invertir(A) {
    const n = A.length;
    const M = A.map((f, i) => [...f, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-12) return null;
      [M[c], M[piv]] = [M[piv], M[c]];
      const div = M[c][c];
      for (let j = 0; j < 2 * n; j++) M[c][j] /= div;
      for (let r = 0; r < n; r++) if (r !== c) {
        const f = M[r][c];
        for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
      }
    }
    return M.map(f => f.slice(n));
  }
  function lnGamma(x) {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += c[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }
  function gammaP(a, x) { // gamma incompleta regularizada inferior
    if (x <= 0) return 0;
    if (x < a + 1) {
      let ap = a, sum = 1 / a, del = sum;
      for (let n = 0; n < 500; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; }
      return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
    }
    let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
    for (let i = 1; i < 500; i++) {
      const an = -i * (i - a);
      b += 2;
      d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-14) break;
    }
    return 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
  }
  function chi2CDF(x, gl) { return gammaP(gl / 2, x / 2); }

  // ============================================================
  // Estadística descriptiva
  // ============================================================
  function cuantil(ordenados, q) {
    if (!ordenados.length) return null;
    const pos = (ordenados.length - 1) * q, b = Math.floor(pos), r = pos - b;
    return ordenados[b + 1] !== undefined ? ordenados[b] + r * (ordenados[b + 1] - ordenados[b]) : ordenados[b];
  }
  function resumenPDC(lista, umbral) {
    const v = lista.map(p => p.pdc).sort((a, b) => a - b);
    const n = v.length;
    if (!n) return { n: 0, media: null, mediana: null, p25: null, p75: null, adherentes: 0, pctAdherentes: null, mprMediana: null, alertas: 0, pctAlertas: null };
    const adherentes = lista.filter(p => p.adherente).length;
    const alertas = lista.filter(p => p.alertaAcumulacion).length;
    return {
      n,
      mprMediana: cuantil(lista.map(p => p.mpr).sort((a, b) => a - b), 0.5),
      alertas,
      pctAlertas: alertas / n * 100,
      media: v.reduce((a, b) => a + b, 0) / n,
      mediana: cuantil(v, 0.5),
      p25: cuantil(v, 0.25),
      p75: cuantil(v, 0.75),
      adherentes,
      pctAdherentes: adherentes / n * 100
    };
  }
  const TRAMOS_PDC = [
    { etiqueta: '<50 %', min: 0, max: 50 },
    { etiqueta: '50–69 %', min: 50, max: 70 },
    { etiqueta: '70–79 %', min: 70, max: 80 },
    { etiqueta: '80–89 %', min: 80, max: 90 },
    { etiqueta: '90–94 %', min: 90, max: 95 },
    { etiqueta: '≥95 %', min: 95, max: Infinity }
  ];
  function distribucionPDC(lista) {
    return TRAMOS_PDC.map(t => ({ tramo: t.etiqueta, n: lista.filter(p => p.pdc >= t.min && p.pdc < t.max).length }));
  }

  // ============================================================
  // Validación de parámetros
  // ============================================================
  function normalizarParametros(datos, p) {
    const P = { ...DEFECTO, ...p, filtros: { ...(p.filtros || {}) } };
    P.desde = typeof P.desde === 'number' ? P.desde : aDia(P.desde);
    P.hasta = typeof P.hasta === 'number' ? P.hasta : aDia(P.hasta);
    if (P.desde === null) P.desde = datos.fechaMin !== null ? sumarMeses(datos.fechaMin, P.lavadoMeses) : null;
    if (P.hasta === null) P.hasta = datos.fechaMax;
    return P;
  }
  function validar(datos, p) {
    const P = normalizarParametros(datos, p);
    const errores = [];
    if (!datos.disps.length) errores.push('No hay dispensaciones de TAR válidas en el fichero.');
    if (!(P.lavadoMeses >= 0) || !Number.isInteger(P.lavadoMeses)) errores.push('El periodo de lavado debe ser un número entero de meses (0 o más).');
    else if (P.cohorte === 'naive' && P.lavadoMeses < LAVADO_NAIVE_MIN) errores.push(`Para analizar pacientes naive el periodo de lavado debe ser de al menos ${LAVADO_NAIVE_MIN} meses (con menos historia no se puede asegurar que el paciente no haya recibido TAR antes).`);
    if (!(P.gracia >= 0)) errores.push('El periodo de gracia no es válido.');
    if (!(P.umbral > 0 && P.umbral <= 100)) errores.push('El umbral de adherencia debe estar entre 1 y 100 %.');
    if (P.modo !== 'tar' && (!P.elementos || !P.elementos.length)) errores.push('Selecciona al menos un principio activo o nombre comercial.');
    if (P.desde === null || P.hasta === null) errores.push('Fechas Desde / Hasta no válidas.');
    else {
      const minimo = sumarMeses(datos.fechaMin, P.lavadoMeses);
      if (P.desde < minimo) errores.push(`"Desde" debe ser igual o posterior al ${diaATexto(minimo)} (primera dispensación del fichero + ${P.lavadoMeses} meses de lavado).`);
      if (P.hasta < P.desde) errores.push('"Hasta" no puede ser anterior a "Desde".');
      if (P.hasta > datos.fechaMax) errores.push(`"Hasta" no puede ser posterior a la última dispensación del fichero (${diaATexto(datos.fechaMax)}).`);
    }
    return { P, errores };
  }

  // ============================================================
  // Análisis principal
  // ============================================================
  function analizar(datos, parametros) {
    const { P, errores } = validar(datos, parametros);
    if (errores.length) return { errores, parametros: P };
    const elementos = P.modo === 'tar' ? ['TAR'] : [...P.elementos];
    const avisos = [];
    if (P.lavadoMeses < LAVADO_NAIVE_MIN && P.cohorte === 'todos') avisos.push(`Periodo de lavado de ${P.lavadoMeses} meses (< ${LAVADO_NAIVE_MIN}): la clasificación de pacientes "naive" no es fiable, porque pueden haber recibido TAR antes del inicio del fichero. Para analizar pacientes naive, usa un lavado de al menos ${LAVADO_NAIVE_MIN} meses.`);

    // Filtro de población por Id de paciente (uno o varios)
    const idsFiltro = P.filtros && P.filtros.id && P.filtros.id.length ? new Set(P.filtros.id.map(txt)) : null;

    const resultados = elementos.map(el => {
      const pdc = [], excluidosPDC = [], pers = [];
      datos.porPaciente.forEach((todas, id) => {
        if (idsFiltro && !idsFiltro.has(id)) return;
        const dispsPac = todas.filter(d => d.dia <= P.hasta);
        if (!dispsPac.length) return;
        const h = historia(dispsPac, el, P);
        if (!h) return;
        const cohorte = clasificar(h, dispsPac, P);
        if (!cohorte) return;
        const ref = filaReferencia(h, P);
        if (!pasaFiltros(ref, P.filtros)) return;
        const pasaCohorte = P.cohorte === 'todos' || P.cohorte === cohorte;
        const previo = cohorte === 'pretratado' ? tratamientoPrevio(dispsPac, h, P) : null;

        // PDC
        if (pasaCohorte) {
          const r = pdcPaciente(h, cohorte, P);
          const reg = { id, cohorte, ...r, adherente: r.pdc !== null && r.pdc >= P.umbral, servicio: ref.servicio, dpto: ref.descDpto, previo };
          if (r.dias < P.pdcMinDias) excluidosPDC.push(reg); else pdc.push(reg);
        }
        // Persistencia (solo nuevos)
        if (cohorte !== 'estable' && pasaCohorte) {
          const r = persistenciaPaciente(h, P);
          pers.push({ id, cohorte, inicio: h.primerDia, ...r, previo, servicio: ref.servicio, dpto: ref.descDpto });
        }
      });

      const porCohorte = {};
      ['naive', 'pretratado', 'estable'].forEach(c => { porCohorte[c] = resumenPDC(pdc.filter(p => p.cohorte === c), P.umbral); });
      const km = kaplanMeier(pers);
      const hitos = [6, 12, 24].map(m => {
        const t = Math.round(m * DIAS_MES);
        const e = estadoEn(km.pasos, t);
        return { meses: m, t, surv: e.surv, ciL: e.ciL, ciU: e.ciU, enRiesgo: enRiesgoEn(pers, t), fiable: enRiesgoEn(pers, t) >= P.minEnRiesgo };
      });
      const motivos = { hueco: pers.filter(s => s.motivo === 'hueco').length, cambio: pers.filter(s => s.motivo === 'cambio').length, censura: pers.filter(s => s.motivo === 'censura').length };
      const destinos = {};
      pers.filter(s => s.motivo === 'cambio').forEach(s => { destinos[s.destino] = (destinos[s.destino] || 0) + 1; });

      return {
        elemento: el,
        pdc: {
          pacientes: pdc,
          excluidos: excluidosPDC,
          resumen: resumenPDC(pdc, P.umbral),
          porCohorte,
          distribucion: distribucionPDC(pdc)
        },
        persistencia: {
          sujetos: pers,
          km,
          hitos,
          motivos,
          destinos: Object.entries(destinos).map(([destino, n]) => ({ destino, n })).sort((a, b) => b.n - a.n),
          naive: pers.filter(s => s.cohorte === 'naive').length,
          pretratados: pers.filter(s => s.cohorte === 'pretratado').length
        }
      };
    });

    // Comparación entre elementos
    let comparacion = null;
    if (resultados.length > 1) {
      const grupos = resultados.map(r => r.persistencia.sujetos).filter(g => g.length);
      const ids = new Map();
      let solapados = 0;
      resultados.forEach((r, gi) => r.persistencia.sujetos.forEach(s => {
        if (ids.has(s.id) && ids.get(s.id) !== gi) solapados++;
        else ids.set(s.id, gi);
      }));
      comparacion = { logRank: grupos.length > 1 ? logRank(grupos) : null, pacientesEnVariosGrupos: solapados };
      if (solapados) avisos.push(`${solapados} pacientes aparecen en más de un grupo: el test log-rank no es formalmente válido (grupos no independientes).`);
    }
    return { parametros: P, resultados, comparacion, avisos, errores: [] };
  }

  // ============================================================
  // Detalle de un paciente (auditoría del cálculo)
  // ============================================================
  function detallePaciente(datos, id, parametros, elemento) {
    const P = normalizarParametros(datos, parametros);
    const todas = (datos.porPaciente.get(id) || []).filter(d => d.dia <= P.hasta);
    const el = P.modo === 'tar' ? 'TAR' : elemento;
    const h = todas.length ? historia(todas, el, P) : null;
    if (!h) return null;
    // Intervalo de cobertura de cada dispensación del elemento
    const intervalo = new Map();
    // La cobertura de la ventana se calcula solo con sus dispensaciones; las anteriores a "Desde"
    // se muestran con su propia cobertura, sin influir en el cálculo.
    const secuencias = [h.eDisps.filter(d => d.dia < P.desde), h.eVentana].flatMap(l => P.modo === 'tar'
      ? Object.values(l.reduce((m, d) => { (m[d.pa] = m[d.pa] || []).push(d); return m; }, {}))
      : [l]).filter(l => l.length);
    secuencias.forEach(l => {
      intervalosSecuencia(l).forEach((iv, i) => {
        const prev = i > 0 ? l[i - 1] : null;
        intervalo.set(l[i], { ...iv, adelanto: iv.ini - iv.dia, hueco: prev ? Math.max(0, iv.dia - intervalo.get(prev).fin - 1) : 0 });
      });
    });
    const cohorte = clasificar(h, todas, P);
    return {
      id, elemento: el, cohorte,
      pdc: cohorte ? pdcPaciente(h, cohorte, P) : null,
      persistencia: cohorte && cohorte !== 'estable' ? persistenciaPaciente(h, P) : null,
      tramos: h.tramos.map(t => ({ ini: t.ini, fin: Math.min(t.fin, P.hasta), cambio: t.cambio ? { dia: t.cambio.S, destino: t.cambio.destino } : null })),
      dispensaciones: todas.map(d => {
        const iv = intervalo.get(d);
        return {
          dia: d.dia, producto: d.producto, pa: d.pa, cantidad: d.cantidad, posologia: d.posologiaUsada,
          posologiaRespaldo: !!d.posologiaRespaldo, suministro: d.suministro, coste: d.coste,
          delElemento: !!iv, cobIni: iv ? iv.ini : null, cobFin: iv ? iv.fin : null,
          adelanto: iv ? iv.adelanto : null, hueco: iv ? iv.hueco : null
        };
      })
    };
  }

  // ============================================================
  // Histórico completo de un paciente (sin filtros ni ventana)
  // ============================================================
  /**
   * Todas las dispensaciones de TAR del paciente con su cobertura por principio activo
   * (desplazando solapamientos), adelantos y huecos, más un resumen por tratamiento.
   */
  function historicoPaciente(datos, id) {
    id = txt(id);
    const disps = datos.porPaciente.get(id);
    if (!disps || !disps.length) return null;
    const porPA = {};
    disps.forEach(d => { (porPA[d.pa] = porPA[d.pa] || []).push(d); });
    const cobertura = new Map();
    Object.values(porPA).forEach(l => {
      intervalosSecuencia(l).forEach((iv, i) => {
        const prev = i > 0 ? cobertura.get(l[i - 1]) : null;
        cobertura.set(l[i], { ini: iv.ini, fin: iv.fin, adelanto: iv.ini - iv.dia, hueco: prev ? Math.max(0, iv.dia - prev.fin - 1) : 0 });
      });
    });
    const tratamientos = Object.entries(porPA).map(([pa, l]) => {
      const ivs = l.map(d => cobertura.get(d));
      return {
        pa,
        productos: [...new Set(l.map(d => d.producto))],
        primera: l[0].dia,
        ultima: l[l.length - 1].dia,
        finCobertura: ivs[ivs.length - 1].fin,
        dispensaciones: l.length,
        unidades: l.reduce((a, d) => a + d.cantidad, 0),
        diasSuministrados: l.reduce((a, d) => a + d.suministro, 0),
        coste: l.reduce((a, d) => a + (d.coste || 0), 0),
        huecoMax: Math.max(0, ...ivs.map(iv => iv.hueco))
      };
    }).sort((a, b) => a.primera - b.primera || a.pa.localeCompare(b.pa));
    const ultima = disps[disps.length - 1];
    return {
      id,
      primera: disps[0].dia,
      ultima: ultima.dia,
      servicio: ultima.servicio,
      dpto: ultima.descDpto,
      patologia: ultima.patologia,
      nDispensaciones: disps.length,
      coste: disps.reduce((a, d) => a + (d.coste || 0), 0),
      tratamientos,
      devoluciones: (datos.devoluciones && datos.devoluciones.get(id)) || [],
      dispensaciones: disps.map(d => {
        const c = cobertura.get(d);
        return {
          dia: d.dia, producto: d.producto, codProducto: d.codProducto, pa: d.pa,
          cantidad: d.cantidad, cantidadOriginal: d.cantidadOriginal, posologia: d.posologiaUsada, posologiaOriginal: d.posologia,
          posologiaRespaldo: !!d.posologiaRespaldo, suministro: d.suministro, coste: d.coste, servicio: d.servicio,
          cobIni: c.ini, cobFin: c.fin, adelanto: c.adelanto, hueco: c.hueco
        };
      })
    };
  }
  function listaIds(datos) {
    return [...datos.porPaciente.keys()].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
  }

  return {
    COL, DEFECTO, DIAS_MES, LAVADO_NAIVE_MIN, detallePaciente, historicoPaciente, listaIds,
    aDia, diaAISO, diaATexto, sumarMeses, aNumero,
    parsePosologia, diasSuministro,
    depurar, opciones, validar, analizar,
    kaplanMeier, estadoEn, survEn, enRiesgoEn, logRank, chi2CDF,
    // internos expuestos para pruebas
    _int: { historia, clasificar, intervalosSecuencia, fusionar, bloquesCobertura, diasCubiertos, pdcPaciente, persistenciaPaciente, cuantil }
  };
});
