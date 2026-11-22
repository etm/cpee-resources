/*
  This file is part of CPEE-RESOURCES.

  CPEE-RESOURCES is free software: you can redistribute it and/or modify it
  under the terms of the GNU Lesser General Public License as published by the
  Free Software Foundation, either version 3 of the License, or (at your
  option) any later version.

  CPEE-RESOURCES is distributed in the hope that it will be useful, but WITHOUT
  ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
  FOR A PARTICULAR PURPOSE. See the GNU Lesser General Public License for
  more details.

  You should have received a copy of the GNU Lesser General Public License
  along with CPEE-RESOURCES (file LICENSE in the main directory). If not, see
  <http://www.gnu.org/licenses/>.
*/

// where the resources service lives, and where the cockpit themes are (to show
// icons as they will look in the cockpit). Set in config.json (like in the
// cockpit), %host is replaced by the host of this page.
const CONFIG_DEFAULTS = {
  'resources-url': '/flow/resources/',
  'themes-url':    '/flow/themes/'
};
var server;
var themes_base;

const SVGNS = 'http://www.w3.org/2000/svg';
const RNGNS = 'http://relaxng.org/ns/structure/1.0';
const NAME  = /^[a-z][a-zA-Z0-9_-]*$/;

const PARTS = ['normal','start','middle','end'];
// attributes the cockpit expects on the part groups (see call.svg of the themes)
const PART_ATTRS = {
  normal: {},
  start:  { 'clip-path': 'url(#startclip)' },
  middle: { 'transform': 'translate(27,0)' },
  end:    { 'clip-path': 'url(#endclip)' }
};
const ICON_TEMPLATE = {
  normal: '<rect x="1" y="1" width="28" height="28" rx="4" class="execstyle colorstyle stand"/>',
  start:  '<rect x="1" y="1" width="38" height="28" rx="4" class="execstyle colorstyle stand"/>',
  middle: '<rect x="0" y="1" width="220" height="28" class="standwithout colorstyle"/>\n' +
          '<line x1="0" y1="1" x2="220" y2="1" class="standline execstyle"/>\n' +
          '<line x1="0" y1="29" x2="220" y2="29" class="standline execstyle"/>\n' +
          '<text transform="translate(0,20)" class="label"></text>',
  end:    '<rect x="1" y="1" width="28" height="28" rx="4" class="execstyle colorstyle stand"/>'
};
const SCHEMA_TEMPLATE =
  '<element rngui:version="1.2" name="arguments" datatypeLibrary="http://www.w3.org/2001/XMLSchema-datatypes" xmlns="http://relaxng.org/ns/structure/1.0" xmlns:rngui="http://rngui.org">\n' +
  '</element>';

const PREVIEW_THEMES = ['preset','extended'];

var adaptors = {}; // theme -> WfAdaptor, null if the theme could not be loaded
var icons = {};
var themes_loaded = Promise.resolve();
var current = {
  schemas: { name: undefined, orig: {}, editors: {} },
  symbols: { name: undefined, orig: {}, editors: {}, root: undefined, attrs: {}, extras: [] }
};
var preview_timer;
var uid = 0;

/* helpers {{{ */
function pretty_children(node) { //{{{
  let out = [];
  Array.from(node.childNodes).forEach((c) => {
    if (c.nodeType == Node.TEXT_NODE && c.nodeValue.trim() == '') { return; }
    out.push($.strip_xmlns($(c).serializePrettyXML(), SVGNS));
  });
  return out.join('\n');
} //}}}
/* }}} */

/* editors (relaxngui) {{{ */
function create_editor(target) { //{{{
  let rng = $XR(
    '<element name="code" rngui:label="Code" xmlns="' + RNGNS + '" xmlns:rngui="http://rngui.org">' +
      '<text rngui:label=""/>' +
    '</element>'
  );
  $('text',rng).attr('rngui:label',target.attr('data-label'));
  target.empty();
  new RelaxNGui(rng,target);
  target.find('ol[contenteditable]').attr('spellcheck','false');
  return target;
} //}}}
function editor_get(ed) { //{{{
  return ed.find('ol[contenteditable]').get_val().replace(/ /g,' ');
} //}}}
function editor_set(ed,text) { //{{{
  ed.find('ol[contenteditable]').set_val(text);
} //}}}
function changed(kind) { //{{{
  let cur = current[kind];
  if (cur.name == undefined) { return false; }
  return Object.keys(cur.editors).some((p) => editor_get(cur.editors[p]) != cur.orig[p]);
} //}}}
function update_state(kind) { //{{{
  // save and revert are only active when there is something to save or revert
  $('div.buttons button',detail(kind)).prop('disabled',!changed(kind));
} //}}}
function detail(kind) { //{{{
  return kind == 'schemas' ? $('#schemadetail') : $('#icondetail');
} //}}}
function list(kind) { //{{{
  return kind == 'schemas' ? $('#schemas') : $('#icons');
} //}}}
function base(name) { //{{{
  return name.replace(/\.[a-z]+$/,'');
} //}}}
function row(kind,name) { //{{{
  return $('tbody tr[data-name="' + name + '"]',list(kind));
} //}}}
function from_template(kind,cls) { //{{{
  return $(list(kind).closest('ui-area').find('template.' + cls)[0].content.firstElementChild.cloneNode(true));
} //}}}
function dialogue(cls,target,name,action) { //{{{
  // opens the dialogue at target, action is called by its button
  let dlg = $('ui-dialogue.' + cls);
  $('span.name',dlg).text(base(name));
  uidash_dialogue(dlg,target);
  dlg.off('click.action').on('click.action','button',() => action(dlg));
  return dlg;
} //}}}
function failed(what,target,name,status) { //{{{
  let dlg = dialogue('failed',target,name);
  $('p[data-action]',dlg).addClass('hidden');
  $('p[data-action=' + what + ']',dlg).removeClass('hidden');
  $('span.status',dlg).text(status);
} //}}}
function show_error(kind,msg) { //{{{
  if (kind == 'schemas') { // in place of the preview
    let pre = $('#schemapreview');
    $('div.error',pre).remove();
    if (msg) { pre.empty().append($('<div class="error"/>').text(msg)); }
    return;
  }
  let err = $('div.error',detail(kind));
  if (msg) {
    err.text(msg).removeClass('hidden');
  } else {
    err.text('').addClass('hidden');
  }
} //}}}
/* }}} */

/* list {{{ */
function paint(kind) { //{{{
  $.ajax({
    type: 'GET',
    url: server + kind + '/',
    dataType: 'xml',
    success: (res) => {
      $('tr:not(.new)',$('tbody',list(kind))).remove();
      $('resource',res).each((_,r) => { add_row(kind,$(r).text()); });
    },
    error: () => {
      $('tr:not(.new)',$('tbody',list(kind))).remove();
    }
  });
} //}}}
function add_row(kind,name,text) { //{{{
  // at its place, the list is sorted by name like the server does
  let tr = from_template(kind,'row');
  tr.attr('data-name',name);
  $('[data-class=name]',tr).text(base(name));
  if (name == current[kind].name) { tr.addClass('selected'); }
  let before = $('tbody tr:not(.new)',list(kind)).filter((_,r) => $(r).attr('data-name') < name).last();
  tr.insertAfter(before.length > 0 ? before : $('tbody tr.new',list(kind)));
  if (kind == 'symbols') { thumbnail(name,$('[data-class=icon]',tr),text); }
} //}}}
function thumbnail(name,td,text) { //{{{
  // drawn like the narrow preview, cut to the 30x30 of the symbol. Without text it is loaded
  if (text === undefined) {
    $.ajax({
      type: 'GET',
      url: server + 'symbols/' + name,
      dataType: 'text',
      success: (res) => thumbnail(name,td,res)
    });
    return;
  }
  let icon;
  try {
    icon = $XR(text);
  } catch(e) {
    td.empty().append(from_template('symbols','broken'));
    return;
  }
  themes_loaded.then(() => {
    if (!adaptors['extended']) { return; }
    td.empty();
    try {
      icons[name] = icon;
      let svg = $(document.createElementNS(SVGNS,'svg')).appendTo(td); // has to be in the document, so that it can be measured
      adaptors['extended'].set_svg_container(svg);
      let g = adaptors['extended'].draw_element('call', 'thumbnail-' + (uid++), $('#iconpreview').attr('data-label'), { info: { 'element-endpoint': name } });
      // symbol -> svg coordinates, incl. the group translate of set_svg. From the transforms
      // themselves, getCTM does not work here, the list is drawn while its tab is hidden
      let m = svg[0].createSVGMatrix();
      for (let e = g.children('g')[0]; e != svg[0]; e = e.parentNode) {
        let t = e.transform && e.transform.baseVal.consolidate();
        if (t) { m = t.matrix.multiply(m); }
      }
      svg.attr('viewBox',m.e + ' ' + m.f + ' 30 30');
      svg.removeAttr('width').removeAttr('height');
    } catch(e) {
      td.empty().append(from_template('symbols','broken').attr('title',e.message));
    }
  });
} //}}}
function events(resync = false) { //{{{
  // the lists follow the changes on the server, also those of others (see notify in implementation.rb)
  let es = new EventSource(server + 'events/');
  es.onopen = () => {
    if (resync) { paint('schemas'); paint('symbols'); } // changes may have been missed in between
    resync = true;
  };
  es.onerror = () => {
    if (es.readyState == EventSource.CLOSED) { setTimeout(() => events(true), 5000); }
  };
  es.onmessage = (e) => {
    let ev = JSON.parse(e.data);
    let kind = ev.kind;
    if (!current[kind]) { return; }
    if (ev.op == 'delete') {
      row(kind,ev.name).remove();
      if (current[kind].name == ev.name) { unselect(kind); }
      return;
    }
    if (row(kind,ev.name).length == 0) {
      add_row(kind,ev.name,ev.content);
    } else if (kind == 'symbols') {
      thumbnail(ev.name,$('td[data-class=icon]',row(kind,ev.name)),ev.content);
    }
    if (current[kind].name == ev.name && !changed(kind) && !shows(kind,ev.content)) {
      show_item(kind,ev.name,ev.content);
    }
  };
} //}}}
/* }}} */

/* select, load, save {{{ */
function leave_ok(kind,target,cont) { //{{{
  // cont when there is nothing to lose, or when discarding was confirmed
  if (!changed(kind)) { cont(); return; }
  dialogue('discard',target,current[kind].name,(dlg) => {
    uidash_dialogue_close(dlg);
    cont();
  });
} //}}}
function select(kind,name,target) { //{{{
  let load = () => $.ajax({
    type: 'GET',
    url: server + kind + '/' + name,
    dataType: 'text',
    success: (res) => show_item(kind,name,res),
    error: (xhr) => { failed('load',target,name,xhr.status); }
  });
  if (name != current[kind].name) {
    leave_ok(kind,target,load);
  } else {
    load();
  }
} //}}}
function show_item(kind,name,text) { //{{{
  current[kind].name = name;
  $('tbody tr',list(kind)).removeClass('selected');
  row(kind,name).addClass('selected');
  let det = detail(kind);
  $('div.nothing',det).addClass('hidden');
  $('div.detail',det).removeClass('hidden');
  $('div.head h1 span.name',det).text(base(name));
  if (kind == 'schemas') {
    editor_set(current.schemas.editors.schema,text.replace(/\s+$/,''));
    current.schemas.orig.schema = editor_get(current.schemas.editors.schema);
  } else {
    load_icon(text);
  }
  update_state(kind);
  update_preview(kind);
} //}}}
function shows(kind,text) { //{{{
  // whether the editors hold exactly this, e.g. after saving it
  try {
    if (kind == 'schemas') { return editor_get(current.schemas.editors.schema) == text.replace(/\s+$/,''); }
    return $(compose_icon()).serializePrettyXML() == text;
  } catch(e) {
    return false;
  }
} //}}}
function unselect(kind) { //{{{
  current[kind].name = undefined;
  current[kind].orig = {};
  $('div.nothing',detail(kind)).removeClass('hidden');
  $('div.detail',detail(kind)).addClass('hidden');
} //}}}
function load_icon(text) { //{{{
  let cur = current.symbols;
  let parts = {};
  cur.attrs = {};
  cur.extras = [];
  try {
    let root = $XR(text).documentElement;
    cur.root = root.cloneNode(false);
    let found = false;
    Array.from(root.childNodes).forEach((c) => {
      let p = c.nodeType == Node.ELEMENT_NODE ? PARTS.find((x) => c.classList.contains('part-' + x)) : undefined;
      if (p && parts[p] == undefined) {
        found = true;
        parts[p] = pretty_children(c);
        cur.attrs[p] = {};
        Array.from(c.attributes).forEach((a) => { if (a.name != 'class') { cur.attrs[p][a.name] = a.value; } });
        cur.attrs[p]['class'] = c.getAttribute('class');
      } else if (!(c.nodeType == Node.TEXT_NODE && c.nodeValue.trim() == '')) {
        cur.extras.push(c);
      }
    });
    if (!found) { // a plain icon, the cockpit uses all of it as the normal part
      parts.normal = pretty_children(root);
      cur.extras = [];
    }
  } catch(e) {
    // not well-formed, show it as is, so that it can be repaired
    cur.root = undefined;
    parts.normal = text;
  }
  PARTS.forEach((p) => {
    editor_set(cur.editors[p],parts[p] || '');
    cur.orig[p] = editor_get(cur.editors[p]);
  });
} //}}}
function compose_icon() { //{{{
  // returns the icon document from the four editors, throws on errors
  let cur = current.symbols;
  let doc = $XR(cur.root ?new XMLSerializer().serializeToString(cur.root) : '<g xmlns="' + SVGNS + '"/>');
  let root = doc.documentElement;
  while (root.firstChild) { root.removeChild(root.firstChild); }
  PARTS.forEach((p) => {
    let text = editor_get(cur.editors[p]);
    if (text.trim() == '') { return; }
    let frag;
    try { // a part is a fragment, it gets a root in the svg namespace
      frag = $XR('<g xmlns="' + SVGNS + '">' + text + '</g>').documentElement;
    } catch(e) {
      throw new Error('Part "' + p + '": ' + e.message);
    }
    let g = doc.createElementNS(SVGNS,'g');
    let attrs = cur.attrs[p] || PART_ATTRS[p];
    Object.keys(attrs).forEach((a) => { if (a != 'class') { g.setAttribute(a,attrs[a]); } });
    g.setAttribute('class',(attrs['class'] || 'part-' + p));
    Array.from(frag.childNodes).forEach((c) => { g.appendChild(doc.importNode(c,true)); });
    root.appendChild(g);
  });
  cur.extras.forEach((c) => { root.appendChild(doc.importNode(c,true)); });
  return doc;
} //}}}
function save(kind) { //{{{
  let cur = current[kind];
  if (cur.name == undefined || !changed(kind)) { return; }
  let button = $('button[name=save]',detail(kind));
  let text;
  try {
    if (kind == 'schemas') {
      text = editor_get(cur.editors.schema);
      $XR(text);
    } else {
      text = $(compose_icon()).serializePrettyXML();
    }
  } catch(e) {
    show_error(kind,e.message);
    $('p.message',dialogue('notsaved',button,cur.name)).text(e.message);
    return;
  }
  put(kind,cur.name,text,button,() => {
    Object.keys(cur.editors).forEach((p) => { cur.orig[p] = editor_get(cur.editors[p]); });
    update_state(kind);
  });
} //}}}
function put(kind,name,text,target,success) { //{{{
  $.ajax({
    type: 'PUT',
    url: server + kind + '/' + name,
    contentType: kind == 'schemas' ? 'text/xml' : 'image/svg+xml',
    processData: false,
    data: text,
    success: success,
    error: (xhr) => { failed('save',target,name,xhr.status); }
  });
} //}}}
/* }}} */

/* create, delete, rename, duplicate {{{ */
function create(kind,nbase,target) { //{{{
  if (!NAME.test(nbase)) { return; }
  let name = nbase + list(kind).attr('data-ext');
  let dlg = $('ui-dialogue.new[data-kind=' + kind + ']');
  uidash_dialogue_close(dlg);
  if (row(kind,name).length > 0) {
    $('input',dlg).val('');
    select(kind,name,target);
    return;
  }
  leave_ok(kind,target,() => {
    let text;
    if (kind == 'schemas') {
      text = SCHEMA_TEMPLATE;
    } else {
      text = '<g xmlns="' + SVGNS + '">\n' + PARTS.map((p) => {
        let attrs = Object.keys(PART_ATTRS[p]).map((a) => ' ' + a + '="' + PART_ATTRS[p][a] + '"').join('');
        return '  <g class="part-' + p + '"' + attrs + '>\n' + ICON_TEMPLATE[p].split('\n').map((l) => '    ' + l).join('\n') + '\n  </g>';
      }).join('\n') + '\n</g>';
    }
    put(kind,name,text,target,() => {
      $('input',dlg).val('');
      current[kind].name = undefined; // nothing to discard anymore
      select(kind,name,target);
    });
  });
} //}}}
function delete_it(kind,name) { //{{{
  let target = $('td[data-class=ops]',row(kind,name));
  dialogue('delete',target,name,(dlg) => {
    uidash_dialogue_close(dlg);
    $.ajax({
      type: 'DELETE',
      url: server + kind + '/' + name,
      error: (xhr) => { failed('delete',target,name,xhr.status); }
    });
  });
} //}}}
function copy_it(kind,name,remove) { //{{{
  let target = $('td[data-class=ops]',row(kind,name));
  let dlg = dialogue(remove ? 'rename' : 'duplicate',target,name,() => submit());
  let inp = $('input',dlg);
  inp.val(base(name)).off('.copy');
  inp.on('input.copy',() => inp[0].setCustomValidity(''));
  inp.on('keydown.copy',(e) => { if (e.key == 'Enter') { e.preventDefault(); submit(); } });
  inp[0].setCustomValidity('');
  inp.focus().select();
  let submit = () => {
    if (!inp[0].reportValidity()) { return; }
    let nname = inp.val() + list(kind).attr('data-ext');
    if (nname == name) { uidash_dialogue_close(dlg); return; }
    if (row(kind,nname).length > 0) {
      inp[0].setCustomValidity(inp.attr('data-exists'));
      inp[0].reportValidity();
      return;
    }
    uidash_dialogue_close(dlg);
    $.ajax({
      type: 'GET',
      url: server + kind + '/' + name,
      dataType: 'text',
      success: (res) => {
        put(kind,nname,res,target,() => {
          if (remove) {
            // before the delete, its event must not close the renamed item
            if (current[kind].name == name) {
              current[kind].name = nname;
              $('div.head h1 span.name',detail(kind)).text(base(nname));
              row(kind,nname).addClass('selected');
            }
            $.ajax({
              type: 'DELETE',
              url: server + kind + '/' + name,
              error: (xhr) => { failed('delete',target,name,xhr.status); }
            });
          }
        });
      },
      error: (xhr) => { failed('load',target,name,xhr.status); }
    });
  };
} //}}}
/* }}} */

/* previews {{{ */
function update_preview(kind) { //{{{
  if (current[kind].name == undefined) { return; }
  show_error(kind);
  if (kind == 'schemas') {
    let pre = $('#schemapreview');
    pre.empty();
    let doc;
    try {
      doc = $XR(editor_get(current.schemas.editors.schema));
    } catch(e) {
      show_error(kind,e.message);
      return;
    }
    if (doc.documentElement.namespaceURI != RNGNS) {
      show_error(kind,'The root element has to be a RelaxNG element (namespace ' + RNGNS + ').');
      return;
    }
    try {
      new RelaxNGui(doc,pre);
    } catch(e) {
      show_error(kind,'RelaxNGui: ' + e.message);
    }
  } else {
    let note = $('#icondetail div.note');
    note.addClass('hidden');
    let cells = $('#iconpreview tbody td');
    cells.empty();
    let icon;
    try {
      icon = compose_icon();
    } catch(e) {
      show_error(kind,e.message);
      return;
    }
    // what the cockpit does with empty parts (see draw_symbol in wfadaptor.js)
    let empty = (p) => editor_get(current.symbols.editors[p]).trim() == '';
    let onlynormal = empty('start') && empty('middle') && empty('end');
    let fallback = onlynormal ? [] : PARTS.filter((p) => empty(p) && !(p == 'start' && !empty('normal')) && !(p == 'end' && !empty('middle')));
    $('p.onlynormal',note).toggleClass('hidden',!onlynormal || empty('normal'));
    $('p.fallback span.parts',note).text(fallback.join(', '));
    $('p.fallback',note).toggleClass('hidden',fallback.length == 0);
    $('p.nostart',note).toggleClass('hidden',onlynormal || !empty('start') || empty('normal'));
    $('p.noend',note).toggleClass('hidden',empty('middle') || !empty('end'));
    let missing = PREVIEW_THEMES.filter((t) => !adaptors[t]);
    $('p.themes span.themes',note).text(missing.join(', '));
    $('p.themes span.url',note).text(themes_base);
    $('p.themes',note).toggleClass('hidden',missing.length == 0);
    note.toggleClass('hidden',$('p:not(.hidden)',note).length == 0);
    icons[current.symbols.name] = icon;
    cells.each((_,td) => {
      let theme = $(td).closest('tr').attr('data-theme');
      if (!adaptors[theme]) { return; }
      try {
        let svg = $(document.createElementNS(SVGNS,'svg')).appendTo(td); // has to be in the document, so that it can be measured
        adaptors[theme].set_svg_container(svg);
        adaptors[theme].draw_element('call', 'preview-' + (uid++), $('#iconpreview').attr('data-label'), { info: { 'element-endpoint': current.symbols.name }, state: $(td).attr('data-state'), style: $(td).attr('data-color') ? { 'fill': $(td).attr('data-color') } : {} });
      } catch(e) {
        $(td).text(e.message);
      }
    });
  }
} //}}}
function load_config() { //{{{
  let apply = (res) => {
    let conf = { ...CONFIG_DEFAULTS, ...res };
    let url = (key) => conf[key].replace('%host',window.location.host).replace(/\/*$/,'/');
    server = url('resources-url');
    themes_base = url('themes-url');
  };
  return new Promise((resolve) => {
    $.ajax({
      type: 'GET',
      url: 'config.json',
      dataType: 'json',
      cache: false,
      success: (res) => { apply(res); resolve(); },
      error: (xhr,status) => {
        if (xhr.status != 404) { alert('fix your config.json (' + status + ')'); }
        apply({});
        resolve();
      }
    });
  });
} //}}}
function load_themes() { //{{{
  // all themes extend WFAdaptorManifestationBase from base.js. One after the
  // other, because each theme.js (re)defines the global WFAdaptorManifestation.
  let load_theme = (t) => new Promise((resolve) => {
    $.ajax({
      type: 'GET',
      url: themes_base + t + '/theme.js',
      dataType: 'text',
      success: () => {
        new WfAdaptor(themes_base + t + '/theme.js',(adaptor) => {
          adaptor.illustrator.get_symbol = (name) => icons[name];
          adaptors[t] = adaptor;
          resolve();
        });
      },
      error: () => { adaptors[t] = null; resolve(); }
    });
  });
  return new Promise((resolve) => {
    $.ajax({
      type: 'GET',
      url: themes_base + 'base.js',
      dataType: 'script',
      cache: true,
      success: () => { PREVIEW_THEMES.reduce((p,t) => p.then(() => load_theme(t)), Promise.resolve()).then(resolve); },
      error: () => { PREVIEW_THEMES.forEach((t) => { adaptors[t] = null; }); resolve(); }
    });
  });
} //}}}
/* }}} */

$(document).ready(function() {
  // editors
  current.schemas.editors.schema = create_editor($('#schemadetail div.editor[data-part=schema]'));
  PARTS.forEach((p) => {
    current.symbols.editors[p] = create_editor($('#icondetail div.editor[data-part=' + p + ']'));
  });
  $('div.help div.fold').on('click',(e) => {
    if ($(e.target).closest('a').length > 0) { return; }
    $(e.currentTarget).parent().toggleClass('closed');
  });
  ['schemas','symbols'].forEach((kind) => {
    $('div.editor',detail(kind)).on('input relaxngui_change paste',() => {
      update_state(kind);
      clearTimeout(preview_timer);
      preview_timer = setTimeout(() => update_preview(kind), 400);
    });
    $('button[name=save]',detail(kind)).on('click',() => save(kind));
    $('button[name=revert]',detail(kind)).on('click',(e) => {
      if (changed(kind)) { select(kind,current[kind].name,$(e.currentTarget)); }
    });

    let tab = list(kind);
    tab.on('click','tbody tr:not(.new) td:not([data-class=ops])',(e) => {
      let tr = $(e.currentTarget).closest('tr');
      select(kind,tr.attr('data-name'),$('td[data-class=name]',tr));
    });
    let dlg = $('ui-dialogue.new[data-kind=' + kind + ']');
    tab.on('click','tr.new',(e) => {
      uidash_dialogue(dlg,$('td[data-class=add]',e.currentTarget));
      $('input',dlg).focus();
    });
    let submit = () => {
      let inp = $('input',dlg);
      if (inp[0].reportValidity()) { create(kind,inp.val(),$('tr.new td[data-class=add]',tab)); }
    };
    dlg.on('click','button',submit);
    dlg.on('keydown','input',(e) => { if (e.key == 'Enter') { e.preventDefault(); submit(); } });
    let ops_menu = (e) => {
      e.preventDefault();
      let tr = $(e.currentTarget).closest('tr');
      let name = tr.attr('data-name');
      let menu = {};
      menu['Operations'] = [
        { 'label': 'Duplicate', 'function_call': copy_it,   'text_icon': '<i class="uidash-icon uidash-icon-copy"></i>',   'type': undefined, 'params': [kind,name,false] },
        { 'label': 'Rename',    'function_call': copy_it,   'text_icon': '<i class="uidash-icon uidash-icon-rename"></i>', 'type': undefined, 'params': [kind,name,true] },
        { 'label': 'Delete',    'function_call': delete_it, 'text_icon': '<i class="uidash-icon uidash-icon-delete"></i>', 'type': undefined, 'params': [kind,name] }
      ];
      tr.addClass('active');
      new CustomMenu(e).contextmenu(menu);
    };
    tab.on('click','tbody tr:not(.new) td[data-class=ops]',ops_menu);
    tab.on('contextmenu','tbody tr:not(.new)',ops_menu);
  });
  $(document).on('mousedown',() => { $('table.ui-table tr.active').removeClass('active'); }); // CustomMenu closes on mousedown

  // ctrl+s saves what is visible
  $(document).on('keydown',(e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() == 's') {
      e.preventDefault();
      save($('ui-tab[data-tab=icons]').hasClass('inactive') ? 'schemas' : 'symbols');
    }
  });
  // icons can only be measured when visible
  document.addEventListener('uidash:activate_tab',(e) => {
    if (e.detail.active == 'icons') { update_preview('symbols'); }
  });
  window.addEventListener('beforeunload',(e) => {
    if (changed('schemas') || changed('symbols')) { e.preventDefault(); e.returnValue = ''; }
  });

  load_config().then(() => {
    themes_loaded = load_themes();
    events();
    paint('schemas');
    paint('symbols');
    themes_loaded.then(() => { update_preview('symbols'); });
  });
});
