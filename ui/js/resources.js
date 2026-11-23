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
  symbols: { name: undefined, orig: {}, editors: {}, root: undefined, attrs: {}, extras: [] },
  endpoints: { name: undefined, orig: {}, editors: {}, form: undefined },
  // schema and icon of the selected endpoint. source is what the endpoint has
  // ('' none, 'own', or the name of the linked global one), mode what is shown
  epschema: { name: undefined, orig: {}, editors: {}, source: '', mode: '' },
  epsymbol: { name: undefined, orig: {}, editors: {}, root: undefined, attrs: {}, extras: [], source: '', mode: '' },
  // descriptions of the selected endpoint. orig is the saved text of a part
  // (undefined when it has none), present which parts are shown
  epdesc: { name: undefined, orig: {}, editors: {}, present: {} }
};
const DESCPARTS = ['endpoint','functionality','output'];
const EPKINDS = ['epschema','epsymbol','epdesc']; // what an endpoint has besides its properties, each in its own tab
const EDITORS = { schemas: ['schema'], symbols: PARTS, epschema: ['schema'], epsymbol: PARTS, epdesc: DESCPARTS };
const TABS = { schemas: 'schemas', icons: 'symbols', endpoints: 'endpoints', props: 'endpoints', schema: 'epschema', icon: 'epsymbol', desc: 'epdesc' };
const TYPE = { schemas: 'schema', symbols: 'icon', epschema: 'schema', epsymbol: 'icon' };
const EPFILE = {
  epschema: { file: 'schema.rng', global: 'schemas', mimetype: 'text/xml',      prop: 'global-schema', what: 'schema' },
  epsymbol: { file: 'symbol.svg', global: 'symbols', mimetype: 'image/svg+xml', prop: 'global-symbol', what: 'icon' }
};
var properties_rng; // promise of ui/rngs/properties.rng, the form of the endpoint properties
var agents; // while the Agents button is on: the endpoints with descriptions (Set), else undefined
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
function editor_fill(kind,p,text) { //{{{
  // as saved, orig is what the editor makes of it
  editor_set(current[kind].editors[p],text);
  current[kind].orig[p] = editor_get(current[kind].editors[p]);
} //}}}
function checkpoint(kind) { //{{{
  // what the editors hold is saved now
  let cur = current[kind];
  Object.keys(cur.editors).forEach((p) => { cur.orig[p] = editor_get(cur.editors[p]); });
} //}}}
function changed(kind) { //{{{
  let cur = current[kind];
  if (cur.name == undefined) { return false; }
  if (kind == 'endpoints') { return cur.form != undefined && cur.form.has_changed(); }
  if (kind == 'epdesc') { return DESCPARTS.some((p) => desc_changed(p)); }
  if (EPFILE[kind]) {
    if (cur.mode != 'own') { return false; } // global ones are only shown
    if (cur.source != 'own') { return true; } // own, but not saved yet
  }
  return edited(kind);
} //}}}
function edited(kind) { //{{{
  // the editors differ from what was loaded (or from the template)
  let cur = current[kind];
  return Object.keys(cur.editors).some((p) => editor_get(cur.editors[p]) != cur.orig[p]);
} //}}}
function dirty(kind) { //{{{
  // an endpoint also has unsaved changes when its schema, icon or description has
  return kind == 'endpoints' ? ['endpoints',...EPKINDS].some((k) => changed(k)) : changed(kind);
} //}}}
function update_state(kind) { //{{{
  // save and revert are only active when there is something to save or revert
  $('.buttons button',area(kind)).prop('disabled',!changed(kind));
} //}}}
function detail(kind) { //{{{
  return $({ schemas: '#schemadetail', symbols: '#icondetail', endpoints: '#endpointdetail', epschema: '#endpointschema', epsymbol: '#endpointicon', epdesc: '#endpointdesc' }[kind]);
} //}}}
function area(kind) { //{{{
  // where the editors and buttons of kind are, the endpoint detail also holds those of its schema and icon
  return kind == 'endpoints' ? $('#endpointprops') : detail(kind);
} //}}}
function list(kind) { //{{{
  return $({ schemas: '#schemas', symbols: '#icons', endpoints: '#endpoints' }[kind]);
} //}}}
function base(name) { //{{{
  return name.replace(/\.[a-z]+$/,'');
} //}}}
function label(kind,name) { //{{{
  // what is shown, endpoints are URLs, base would cut e.g. .php
  return kind == 'endpoints' || kind == 'epdesc' || EPFILE[kind] ? name : base(name);
} //}}}
function path(kind,name) { //{{{
  // endpoints are named by their URL. Encoded once, like the cockpit does: the
  // service unescapes the path twice (riddl server.rb), nginx (/flow/resources/) once
  if (kind == 'endpoints') { return server + 'endpoints/' + encodeURIComponent(name); }
  return server + kind + '/' + name;
} //}}}
function visible() { //{{{
  // the kind whose tab is shown
  let kind = TABS[$('#main > ui-tabbar > ui-tab:not(.inactive)').attr('data-tab')];
  return kind == 'endpoints' ? TABS[$('#endpointdetail > ui-tabbar > ui-tab:not(.inactive)').attr('data-tab')] : kind;
} //}}}
function row(kind,name) { //{{{
  return $('tbody tr:not(.new)',list(kind)).filter((_,r) => $(r).attr('data-name') == name);
} //}}}
function plain_props(obj) { //{{{
  // properties as the form holds them: strings only, without what the service computes
  let res = {};
  if (obj && typeof obj == 'object' && !Array.isArray(obj)) {
    Object.keys(obj).forEach((k) => {
      if (k == 'global-schema' || k == 'global-symbol') { return; }
      res[k] = obj[k] == null ? '' : (typeof obj[k] == 'object' ? JSON.stringify(obj[k]) : String(obj[k]));
    });
  }
  return res;
} //}}}
function from_template(kind,cls) { //{{{
  return $(list(kind).closest('ui-area').find('template.' + cls)[0].content.firstElementChild.cloneNode(true));
} //}}}
function dialogue(cls,target,text,action) { //{{{
  // opens the dialogue at target, action is called by its buttons (with the button). text is the label of the item
  let dlg = $('ui-dialogue.' + cls);
  $('span.name',dlg).text(text);
  uidash_dialogue(dlg,target);
  dlg.off('click.action').on('click.action','button',(e) => action(dlg,$(e.currentTarget)));
  return dlg;
} //}}}
function only(dlg,attr,val) { //{{{
  // the one paragraph of the dialogue that fits
  $('p[' + attr + ']',dlg).addClass('hidden');
  $('p[' + attr + '=' + val + ']',dlg).removeClass('hidden');
} //}}}
function ask(cls,target,text,why,yes,no) { //{{{
  // a yes/no dialogue, the case why its text. No, the close button or a click outside is no
  let ok = false;
  let dlg = dialogue(cls,target,text,(d,button) => {
    ok = button.attr('name') == 'yes';
    uidash_dialogue_close(d);
  });
  only(dlg,'data-case',why);
  dlg.off('uidash:dialogue_close').one('uidash:dialogue_close',() => { if (ok) { yes(); } else if (no) { no(); } });
  return dlg;
} //}}}
function failed(what,target,text,status) { //{{{
  let dlg = dialogue('failed',target,text);
  only(dlg,'data-action',what);
  $('span.status',dlg).text(status);
} //}}}
function delete_item(kind,name,target) { //{{{
  $.ajax({
    type: 'DELETE',
    url: path(kind,name),
    error: (xhr) => { failed('delete',target,label(kind,name),xhr.status); }
  });
} //}}}
function drawing(adaptor,td) { //{{{
  // an svg for adaptor in td. It has to be in the document, so that it can be measured
  let svg = $(document.createElementNS(SVGNS,'svg')).appendTo(td);
  adaptor.set_svg_container(svg);
  return svg;
} //}}}
function show_error(kind,msg) { //{{{
  if (TYPE[kind] == 'schema') { // in place of the preview
    let pre = $('div.preview',detail(kind));
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
      $('resource',res).each((_,r) => { add_row(kind,kind == 'endpoints' ? decodeURIComponent($(r).text()) : $(r).text()); });
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
  $('[data-class=name]',tr).text(label(kind,name));
  if (kind == 'endpoints') { $('[data-class=name]',tr).attr('title',name); } // cut when too long
  if (name == current[kind].name) { tr.addClass('selected'); }
  let before = $('tbody tr:not(.new)',list(kind)).filter((_,r) => $(r).attr('data-name') < name).last();
  tr.insertAfter(before.length > 0 ? before : $('tbody tr.new',list(kind)));
  filter(kind,tr);
  if (kind == 'symbols') { thumbnail(name,$('[data-class=icon]',tr),text); }
} //}}}
function filter(kind,rows) { //{{{
  let f = $('input.filter[data-kind=' + kind + ']').val().trim().toLowerCase();
  (rows || $('tbody tr:not(.new)',list(kind))).each((_,r) => {
    let name = $(r).attr('data-name');
    let hide = f != '' && !label(kind,name).toLowerCase().includes(f);
    if (kind == 'endpoints' && agents) { hide = hide || !agents.has(name); }
    $(r).toggleClass('hidden',hide);
  });
} //}}}
function load_agents() { //{{{
  // endpoints with descriptions. Loaded whenever the button is switched on or
  // endpoints change (a change of a description is an update of its endpoint)
  if (!agents) { return; }
  $.ajax({
    type: 'GET',
    url: server + 'endpoints/',
    data: { description: 'true' },
    dataType: 'xml',
    success: (res) => {
      if (!agents) { return; }
      agents = new Set($('resource',res).map((_,r) => decodeURIComponent($(r).attr('endpoint'))).get());
      filter('endpoints');
    }
  });
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
      let svg = drawing(adaptors['extended'],td);
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
    if (resync) { paint('schemas'); paint('symbols'); paint('endpoints'); load_agents(); } // changes may have been missed in between
    resync = true;
  };
  es.onerror = () => {
    if (es.readyState == EventSource.CLOSED) { setTimeout(() => events(true), 5000); }
  };
  es.onmessage = (e) => {
    let ev = JSON.parse(e.data);
    let kind = ev.kind;
    if (!current[kind]) { return; }
    if (kind == 'endpoints') { load_agents(); } // e.g. a copy has the descriptions of the original
    if (kind == 'endpoints' && ev.op == 'update' && current.endpoints.name == ev.name) { // also its schema, icon or description
      EPKINDS.forEach((k) => load_part(k));
    }
    Object.keys(EPFILE).forEach((k) => { // the global one the endpoint links to
      if (EPFILE[k].global == kind && current[k].name != undefined && current[k].source == ev.name) { ep_load(k); }
    });
    let linkable = () => { // the lists to link to, from the changed rows
      Object.keys(EPFILE).forEach((k) => { if (EPFILE[k].global == kind) { ep_options(k); } });
    };
    if (ev.op == 'delete') {
      row(kind,ev.name).remove();
      linkable();
      if (current[kind].name == ev.name) { unselect(kind); }
      return;
    }
    if (row(kind,ev.name).length == 0) {
      add_row(kind,ev.name,ev.content);
    } else if (kind == 'symbols') {
      thumbnail(ev.name,$('td[data-class=icon]',row(kind,ev.name)),ev.content);
    }
    linkable();
    if (ev.content !== undefined && current[kind].name == ev.name && !changed(kind) && !shows(kind,ev.content)) {
      show_item(kind,ev.name,ev.content);
    }
  };
} //}}}
/* }}} */

/* select, load, save {{{ */
function leave_ok(kind,target,cont) { //{{{
  // cont when there is nothing to lose, or when discarding was confirmed
  if (!dirty(kind)) { cont(); return; }
  dialogue('discard',target,label(kind,current[kind].name),(dlg) => {
    uidash_dialogue_close(dlg);
    cont();
  });
} //}}}
function select(kind,name,target) { //{{{
  let load = () => $.ajax({
    type: 'GET',
    url: path(kind,name) + (kind == 'endpoints' ? '/properties.json' : ''),
    dataType: 'text',
    success: (res) => show_item(kind,name,res),
    error: (xhr) => { failed('load',target,label(kind,name),xhr.status); }
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
  show_detail(kind,true);
  $('div.head h1 span.name',detail(kind)).text(label(kind,name));
  if (kind == 'endpoints') {
    properties_rng.then((rng) => {
      // a new form each time, content would add to the rows already there
      let props = {};
      try { props = plain_props(JSON.parse(text)); } catch(e) { }
      let cur = current.endpoints;
      cur.form = new RelaxNGui(rng,$('#endpointform').empty());
      cur.form.content_object(props);
      cur.form.set_checkpoint();
      update_state(kind);
    });
    // unsaved changes of the schema, icon or description are only dropped for another endpoint
    EPKINDS.forEach((k) => load_part(k,current[k].name != name));
    return;
  }
  fill(kind,text);
  update_state(kind);
  update_preview(kind);
} //}}}
function show_detail(kind,on) { //{{{
  // the detail of the selected item, or the placeholder
  $('div.nothing',detail(kind)).toggleClass('hidden',on);
  $('div.detail',detail(kind)).toggleClass('hidden',!on);
} //}}}
function fill(kind,text) { //{{{
  // the editors of a schema or icon, as saved
  if (TYPE[kind] == 'schema') {
    editor_fill(kind,'schema',text.trimEnd());
  } else {
    load_icon(kind,text);
  }
} //}}}
function form_props() { //{{{
  return plain_props(current.endpoints.form.save_object());
} //}}}
function shows(kind,text) { //{{{
  // whether the editors hold exactly this, e.g. after saving it
  try {
    if (kind == 'endpoints') {
      let a = form_props(), b = plain_props(JSON.parse(text));
      return Object.keys(a).length == Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);
    }
    if (TYPE[kind] == 'schema') { return editor_get(current[kind].editors.schema) == text.trimEnd(); }
    return $(compose_icon(kind)).serializePrettyXML() == text;
  } catch(e) {
    return false;
  }
} //}}}
function unselect(kind) { //{{{
  (kind == 'endpoints' ? ['endpoints',...EPKINDS] : [kind]).forEach((k) => {
    current[k].name = undefined;
    current[k].orig = {};
  });
  if (kind == 'endpoints') { current.epdesc.present = {}; }
  show_detail(kind,false);
} //}}}
function load_icon(kind,text) { //{{{
  let cur = current[kind];
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
  PARTS.forEach((p) => editor_fill(kind,p,parts[p] || ''));
} //}}}
function compose_icon(kind) { //{{{
  // returns the icon document from the four editors, throws on errors
  let cur = current[kind];
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
  let button = $('button[name=save]',area(kind));
  if (kind == 'epdesc') { desc_save(button); return; }
  if (kind == 'endpoints') {
    put(kind,cur.name,JSON.stringify(form_props()),button,() => {
      cur.form.set_checkpoint();
      update_state(kind);
    });
    return;
  }
  let text;
  try {
    if (TYPE[kind] == 'schema') {
      text = editor_get(cur.editors.schema);
      $XR(text);
    } else {
      text = $(compose_icon(kind)).serializePrettyXML();
    }
  } catch(e) {
    show_error(kind,e.message);
    $('p.message',dialogue('notsaved',button,label(kind,cur.name))).text(e.message);
    return;
  }
  if (EPFILE[kind]) {
    ep_save(kind,text,button);
    return;
  }
  put(kind,cur.name,text,button,() => {
    checkpoint(kind);
    update_state(kind);
  });
} //}}}
function put(kind,name,text,target,success) { //{{{
  $.ajax({
    type: 'PUT',
    url: path(kind,name) + (kind == 'endpoints' ? '/properties.json' : ''),
    contentType: { schemas: 'text/xml', symbols: 'image/svg+xml', endpoints: 'application/json' }[kind],
    processData: false,
    data: text,
    success: success,
    error: (xhr) => { failed('save',target,label(kind,name),xhr.status); }
  });
} //}}}
function template(kind) { //{{{
  // a new schema or icon
  if (TYPE[kind] == 'schema') { return SCHEMA_TEMPLATE; }
  return '<g xmlns="' + SVGNS + '">\n' + PARTS.map((p) => {
    let attrs = Object.keys(PART_ATTRS[p]).map((a) => ' ' + a + '="' + PART_ATTRS[p][a] + '"').join('');
    return '  <g class="part-' + p + '"' + attrs + '>\n' + ICON_TEMPLATE[p].split('\n').map((l) => '    ' + l).join('\n') + '\n  </g>';
  }).join('\n') + '\n</g>';
} //}}}
/* }}} */

/* schema and icon of an endpoint {{{ */
function load_part(kind,force = false) { //{{{
  // schema, icon or description of the selected endpoint. Unsaved changes are kept unless forced
  if (kind == 'epdesc') { desc_load(force); } else { ep_load(kind,force); }
} //}}}
function outdated(kind,name,force) { //{{{
  // when loaded: meanwhile another endpoint is selected, or there are changes to keep
  return name == undefined || current.endpoints.name != name || (!force && changed(kind));
} //}}}
function ep_url(kind) { //{{{
  return path('endpoints',current.endpoints.name) + '/' + EPFILE[kind].file;
} //}}}
function ep_load(kind,force) { //{{{
  // what the endpoint has: none, a link to a global one, or its own
  let name = current.endpoints.name;
  if (outdated(kind,name,force)) { return; }
  $.ajax({
    type: 'GET',
    url: path('endpoints',name) + '/properties.json',
    dataType: 'json',
    success: (props) => {
      let linked = props[EPFILE[kind].prop];
      $.ajax({
        type: 'GET',
        url: ep_url(kind),
        dataType: 'text',
        success: (text) => ep_show(kind,name,linked ? linked : 'own',text,force),
        error: () => ep_show(kind,name,linked ? linked : '','',force) // none, or a link to a missing global one
      });
    }
  });
} //}}}
function ep_show(kind,name,source,text,force) { //{{{
  if (outdated(kind,name,force)) { return; }
  let cur = current[kind];
  cur.name = name;
  cur.source = source;
  cur.mode = source;
  fill(kind,text);
  ep_state(kind);
} //}}}
function ep_state(kind) { //{{{
  // the editors only for an own one, the preview for an own and a global one
  let cur = current[kind];
  let det = detail(kind);
  ep_radios(kind);
  $('div.globals',det).toggleClass('hidden',!ep_global(cur.mode));
  ep_options(kind);
  $('div.own',det).toggleClass('hidden',cur.mode != 'own');
  $('div.shown',det).toggleClass('hidden',cur.mode == '');
  update_state(kind);
  update_preview(kind);
  ep_center(kind);
} //}}}
function ep_center(kind) { //{{{
  // the linked one in the middle of the list. Only when shown, a hidden tab has no layout
  let box = $('div.globals div.globallist',detail(kind));
  let tr = $('tr.selected:not(.hidden)',box);
  if (tr.length == 0 || !box.is(':visible')) { return; }
  box.scrollTop(tr[0].offsetTop - (box[0].clientHeight - tr[0].offsetHeight) / 2); // offsetTop is from the table, which starts the box
} //}}}
function ep_global(mode) { //{{{
  return mode != '' && mode != 'own';
} //}}}
function ep_radios(kind) { //{{{
  // none, own or global, as shown
  let mode = current[kind].mode;
  $('p.source input[value="' + (ep_global(mode) ? 'global' : mode) + '"]',detail(kind)).prop('checked',true);
} //}}}
function ep_options(kind) { //{{{
  // the global ones as in their list, the linked one selected. A link to a
  // missing one is kept, so that it is shown
  let det = detail(kind);
  let gkind = EPFILE[kind].global;
  let tbody = $('div.globals tbody',det);
  let names = $('tbody tr:not(.new)',list(gkind)).map((_,r) => $(r).attr('data-name')).get();
  let mode = current[kind].mode;
  if (ep_global(mode) && !names.includes(mode)) { names.push(mode); }
  let f = $('div.globals input.filter',det).val().trim().toLowerCase();
  tbody.empty();
  names.forEach((n) => {
    let tr = $('<tr><td data-class="icon"></td><td data-class="name"></td></tr>').attr('data-name',n);
    $('td[data-class=name]',tr).text(base(n));
    let icon = $('td[data-class=icon]',row(gkind,n));
    $('td[data-class=icon]',tr).append(icon.length > 0 ? icon.contents().clone() : $('<i class="uidash-icon uidash-icon-info" title="missing"></i>'));
    tr.toggleClass('selected',n == mode);
    tr.toggleClass('hidden',f != '' && !base(n).toLowerCase().includes(f));
    tbody.append(tr);
  });
} //}}}
function ep_choose(kind,val,target) { //{{{
  // none deletes the file, a global one links to it, own shows the editors (saved with save)
  let cur = current[kind];
  if (cur.name == undefined || val == cur.mode) { return; }
  let done = () => {
    cur.mode = val;
    ep_load(kind,true);
  };
  let go = () => {
    if (val == 'own') { // nothing on the server until saved
      cur.mode = 'own';
      if (cur.source != 'own') { fill(kind,template(kind)); }
      ep_state(kind);
      return;
    }
    if (val == cur.source) { done(); return; } // back to what the endpoint has
    $.ajax({
      type: val == '' ? 'DELETE' : 'PUT',
      url: ep_url(kind),
      data: val == '' ? undefined : { name: val },
      success: done,
      error: (xhr) => { ep_state(kind); failed('save',target,cur.name,xhr.status); }
    });
  };
  ep_radios(kind); // as it is, until it is done
  // asked when a saved own one is removed, when the link is removed (switching to another
  // global one only replaces it), or when edits are lost. An untouched template is not
  let why;
  if (val != 'own' && val != cur.source && cur.source == 'own') { why = 'own'; }
  else if (val == '' && ep_global(cur.source)) { why = 'link'; }
  else if (val != 'own' && cur.mode == 'own' && edited(kind)) { why = 'edits'; }
  if (why) {
    let dlg = ask('replace',target,cur.name,why,go,() => ep_state(kind)); // no: back to what is active
    $('span.what',dlg).text(EPFILE[kind].what);
    $('span.global',dlg).text(base(cur.source));
    return;
  }
  go();
} //}}}
function ep_save(kind,text,button) { //{{{
  // as a file, a link is replaced
  let cur = current[kind];
  let data = new FormData();
  data.append('file',new Blob([text],{ type: EPFILE[kind].mimetype }),EPFILE[kind].file);
  $.ajax({
    type: 'PUT',
    url: ep_url(kind),
    data: data,
    processData: false,
    contentType: false,
    success: () => {
      cur.source = 'own';
      checkpoint(kind);
      update_state(kind);
    },
    error: (xhr) => { failed('save',button,cur.name,xhr.status); }
  });
} //}}}
/* }}} */

/* descriptions of an endpoint {{{ */
function desc_url(part,name = current.endpoints.name) { //{{{
  return path('endpoints',name) + '/descriptions/' + part + '.md';
} //}}}
function desc_changed(part) { //{{{
  // added and not saved yet, or edited. Deleting is not a change, it is done at once
  let cur = current.epdesc;
  if (!cur.present[part]) { return false; }
  return cur.orig[part] === undefined || editor_get(cur.editors[part]) != cur.orig[part];
} //}}}
function desc_load(force) { //{{{
  // the parts the endpoint has
  let name = current.endpoints.name;
  if (outdated('epdesc',name,force)) { return; }
  $.ajax({
    type: 'GET',
    url: path('endpoints',name) + '/descriptions/',
    dataType: 'xml',
    success: (res) => {
      let have = $('resource',res).map((_,r) => $(r).text()).get();
      Promise.all(DESCPARTS.map((p) => !have.includes(p + '.md') ? undefined : $.ajax({
        type: 'GET',
        url: desc_url(p,name),
        dataType: 'text'
      }).catch(() => undefined))).then((texts) => desc_show(name,texts,force));
    },
    error: () => desc_show(name,[],force) // no descriptions at all
  });
} //}}}
function desc_show(name,texts,force) { //{{{
  if (outdated('epdesc',name,force)) { return; }
  let cur = current.epdesc;
  cur.name = name;
  DESCPARTS.forEach((p,i) => {
    cur.present[p] = texts[i] !== undefined;
    editor_fill('epdesc',p,cur.present[p] ? texts[i].trimEnd() : '');
    if (!cur.present[p]) { cur.orig[p] = undefined; }
  });
  desc_state();
} //}}}
function desc_state() { //{{{
  let cur = current.epdesc;
  DESCPARTS.forEach((p) => {
    $('div.descpart[data-part=' + p + ']',detail('epdesc')).toggleClass('missing',!cur.present[p]);
  });
  update_state('epdesc');
} //}}}
function desc_add(part) { //{{{
  // shown empty, saved with save
  let cur = current.epdesc;
  if (cur.name == undefined) { return; }
  cur.present[part] = true;
  editor_set(cur.editors[part],'');
  desc_state();
  cur.editors[part].find('ol[contenteditable]').focus();
} //}}}
function desc_delete(part,target) { //{{{
  // a saved part is deleted at once, after asking. An unsaved one is only
  // removed, asked only when something was written into it
  let cur = current.epdesc;
  if (cur.name == undefined) { return; }
  let remove = () => {
    cur.present[part] = false;
    cur.orig[part] = undefined;
    editor_set(cur.editors[part],'');
    desc_state();
  };
  let saved = cur.orig[part] !== undefined;
  if (!saved && editor_get(cur.editors[part]).trim() == '') { remove(); return; }
  let dlg = ask('descdelete',target,cur.name,saved ? 'saved' : 'edits',() => {
    if (!saved) { remove(); return; }
    $.ajax({
      type: 'DELETE',
      url: desc_url(part),
      success: remove,
      error: (xhr) => { failed('delete',target,cur.name,xhr.status); }
    });
  });
  $('span.part',dlg).text(cur.editors[part].attr('data-label'));
} //}}}
function desc_save(button) { //{{{
  // the added and edited parts, each as its own file
  let cur = current.epdesc;
  let parts = DESCPARTS.filter((p) => desc_changed(p));
  Promise.all(parts.map((p) => {
    let text = editor_get(cur.editors[p]);
    return $.ajax({
      type: 'PUT',
      url: desc_url(p),
      contentType: 'text/markdown',
      processData: false,
      data: text
    }).then(() => { cur.orig[p] = text; });
  })).then(
    () => update_state('epdesc'),
    (xhr) => { update_state('epdesc'); failed('save',button,cur.name,xhr.status); }
  );
} //}}}
/* }}} */

/* create, delete, rename, duplicate {{{ */
function create(kind,nbase,target) { //{{{
  if (kind == 'endpoints' ? nbase.trim() == '' : !NAME.test(nbase)) { return; }
  let name = kind == 'endpoints' ? nbase.trim() : nbase + list(kind).attr('data-ext');
  let dlg = $('ui-dialogue.new[data-kind=' + kind + ']');
  uidash_dialogue_close(dlg);
  if (row(kind,name).length > 0) {
    $('input',dlg).val('');
    select(kind,name,target);
    return;
  }
  let created = () => {
    $('input',dlg).val('');
    current[kind].name = undefined; // nothing to discard anymore
    select(kind,name,target);
  };
  leave_ok(kind,target,() => {
    if (kind == 'endpoints') {
      $.ajax({
        type: 'POST',
        url: server + 'endpoints/',
        data: { name: name },
        success: created,
        error: (xhr) => { failed('save',target,name,xhr.status); }
      });
    } else {
      put(kind,name,template(kind),target,created);
    }
  });
} //}}}
function delete_it(kind,name) { //{{{
  let target = $('td[data-class=ops]',row(kind,name));
  dialogue('delete',target,label(kind,name),(dlg) => {
    uidash_dialogue_close(dlg);
    delete_item(kind,name,target);
  });
} //}}}
function copy_it(kind,name,remove) { //{{{
  let target = $('td[data-class=ops]',row(kind,name));
  let dlg = dialogue(remove ? 'rename' : 'duplicate',target,label(kind,name),() => submit());
  let inp = $('input',dlg);
  // the dialogues are shared, endpoint URLs have no name rule
  if (inp.attr('data-pattern') == undefined) { inp.attr('data-pattern',inp.attr('pattern')); }
  if (kind == 'endpoints') { inp.removeAttr('pattern'); } else { inp.attr('pattern',inp.attr('data-pattern')); }
  $('span.rule',dlg).toggleClass('hidden',kind == 'endpoints');
  inp.val(label(kind,name)).off('.copy');
  inp.on('input.copy',() => inp[0].setCustomValidity(''));
  inp.on('keydown.copy',(e) => { if (e.key == 'Enter') { e.preventDefault(); submit(); } });
  inp[0].setCustomValidity('');
  inp.focus().select();
  let submit = () => {
    if (!inp[0].reportValidity()) { return; }
    let nname = kind == 'endpoints' ? inp.val().trim() : inp.val() + list(kind).attr('data-ext');
    if (nname == name) { uidash_dialogue_close(dlg); return; }
    if (row(kind,nname).length > 0) {
      inp[0].setCustomValidity(inp.attr('data-exists'));
      inp[0].reportValidity();
      return;
    }
    uidash_dialogue_close(dlg);
    let copied = () => {
      if (!remove) { return; }
      // before the delete, its event must not close the renamed item
      if (current[kind].name == name) {
        current[kind].name = nname;
        if (kind == 'endpoints') { EPKINDS.forEach((k) => { if (current[k].name == name) { current[k].name = nname; } }); }
        $('div.head h1 span.name',detail(kind)).text(label(kind,nname));
        row(kind,nname).addClass('selected');
      }
      delete_item(kind,name,target);
    };
    if (kind == 'endpoints') { // with all its files, the service copies it
      $.ajax({
        type: 'POST',
        url: server + 'endpoints/',
        data: { name: nname, from: name },
        success: copied,
        error: (xhr) => { failed('save',target,nname,xhr.status); }
      });
      return;
    }
    $.ajax({
      type: 'GET',
      url: path(kind,name),
      dataType: 'text',
      success: (res) => { put(kind,nname,res,target,copied); },
      error: (xhr) => { failed('load',target,label(kind,name),xhr.status); }
    });
  };
} //}}}
/* }}} */

/* previews {{{ */
function update_preview(kind) { //{{{
  if (current[kind].name == undefined || kind == 'endpoints' || kind == 'epdesc') { return; }
  if (EPFILE[kind] && current[kind].mode == '') { return; }
  show_error(kind);
  let det = detail(kind);
  if (TYPE[kind] == 'schema') {
    let pre = $('div.preview',det);
    pre.empty();
    let doc;
    try {
      doc = $XR(editor_get(current[kind].editors.schema));
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
    let note = $('div.note',det);
    note.addClass('hidden');
    let table = $('table.preview',det);
    let cells = $('tbody td',table);
    cells.empty();
    let icon;
    try {
      icon = compose_icon(kind);
    } catch(e) {
      show_error(kind,e.message);
      return;
    }
    // what the cockpit does with empty parts (see draw_symbol in wfadaptor.js)
    let empty = (p) => editor_get(current[kind].editors[p]).trim() == '';
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
    let key = (kind == 'epsymbol' ? 'endpoint ' : '') + current[kind].name; // endpoint URLs and global names must not clash
    icons[key] = icon;
    cells.each((_,td) => {
      let theme = $(td).closest('tr').attr('data-theme');
      if (!adaptors[theme]) { return; }
      try {
        drawing(adaptors[theme],td);
        adaptors[theme].draw_element('call', 'preview-' + (uid++), table.attr('data-label'), { info: { 'element-endpoint': key }, state: $(td).attr('data-state'), style: $(td).attr('data-color') ? { 'fill': $(td).attr('data-color') } : {} });
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

/* bindings {{{ */
function bind_editing(kind) { //{{{
  // editors, save and revert, all kinds
  $('div.editor, div.form',area(kind)).on('input relaxngui_change paste',() => {
    update_state(kind);
    clearTimeout(preview_timer);
    preview_timer = setTimeout(() => update_preview(kind), 400);
  });
  $('button[name=save]',area(kind)).on('click',() => save(kind));
  $('button[name=revert]',area(kind)).on('click',(e) => {
    if (!changed(kind)) { return; }
    if (EPKINDS.includes(kind)) { load_part(kind,true); } else { select(kind,current[kind].name,$(e.currentTarget)); }
  });
} //}}}
function bind_list(kind) { //{{{
  // select, filter, create, and the operations of the rows
  let tab = list(kind);
  $('input.filter[data-kind=' + kind + ']').on('input',() => filter(kind));
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
    let item = (lab,icon,fun,params) => ({ 'label': lab, 'function_call': fun, 'text_icon': '<i class="uidash-icon uidash-icon-' + icon + '"></i>', 'type': undefined, 'params': params });
    tr.addClass('active');
    new CustomMenu(e).contextmenu({ 'Operations': [
      item('Duplicate','copy',copy_it,[kind,name,false]),
      item('Rename','rename',copy_it,[kind,name,true]),
      item('Delete','delete',delete_it,[kind,name])
    ]});
  };
  tab.on('click','tbody tr:not(.new) td[data-class=ops]',ops_menu);
  tab.on('contextmenu','tbody tr:not(.new)',ops_menu);
} //}}}
function bind_epfile(kind) { //{{{
  // none, own or a global one for the schema or icon of an endpoint
  let det = detail(kind);
  $('p.source input',det).on('change',(e) => {
    let val = $(e.currentTarget).val();
    if (val == 'global' && ep_global(current[kind].source)) { // the link was only replaced by unsaved own, it still exists
      ep_choose(kind,current[kind].source,$(e.currentTarget).parent());
    } else if (val == 'global') { // linked when one is clicked
      $('div.globals',det).removeClass('hidden');
      ep_options(kind);
      ep_center(kind);
      $('div.globals input.filter',det).focus();
    } else {
      $('div.globals',det).addClass('hidden');
      ep_choose(kind,val,$(e.currentTarget).parent());
    }
  });
  $('div.globals input.filter',det).on('input',() => ep_options(kind));
  $('div.globals tbody',det).on('click','tr',(e) => ep_choose(kind,$(e.currentTarget).attr('data-name'),$('td[data-class=name]',e.currentTarget)));
} //}}}
function bind_desc() { //{{{
  // add and delete the parts of a description
  DESCPARTS.forEach((p) => {
    let part = $('div.descpart[data-part=' + p + ']',detail('epdesc'));
    $('button[name=add]',part).on('click',() => desc_add(p));
    $('button[name=delete]',part).on('click',(e) => desc_delete(p,$(e.currentTarget)));
  });
} //}}}
/* }}} */

$(document).ready(function() {
  Object.keys(EDITORS).forEach((kind) => {
    EDITORS[kind].forEach((p) => { current[kind].editors[p] = create_editor($('div.editor[data-part=' + p + ']',area(kind))); });
  });
  $('div.help div.fold').on('click',(e) => {
    if ($(e.target).closest('a').length > 0) { return; }
    $(e.currentTarget).parent().toggleClass('closed');
  });
  properties_rng = new Promise((resolve) => {
    $.ajax({ type: 'GET', url: 'rngs/properties.rng', dataType: 'xml', success: resolve });
  });
  ['schemas','symbols','endpoints',...EPKINDS].forEach((kind) => {
    bind_editing(kind);
    if (kind == 'epdesc') { bind_desc(); } else if (EPFILE[kind]) { bind_epfile(kind); } else { bind_list(kind); }
  });
  $(document).on('mousedown',() => { $('table.ui-table tr.active').removeClass('active'); }); // CustomMenu closes on mousedown
  $('div.filterbar button.agents').on('click',(e) => {
    let on = !agents;
    $(e.currentTarget).attr('aria-pressed',String(on));
    agents = on ? new Set() : undefined; // empty until loaded
    filter('endpoints');
    load_agents();
  });

  // ctrl+s saves what is visible
  $(document).on('keydown',(e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() == 's') {
      e.preventDefault();
      if (visible()) { save(visible()); }
    }
  });
  // icons and the list to link to can only be measured when visible
  document.addEventListener('uidash:activate_tab',() => {
    let kind = visible();
    if (TYPE[kind] == 'icon') { update_preview(kind); }
    if (EPFILE[kind]) { ep_center(kind); }
  });
  window.addEventListener('beforeunload',(e) => {
    if (changed('schemas') || changed('symbols') || dirty('endpoints')) { e.preventDefault(); e.returnValue = ''; }
  });

  load_config().then(() => {
    themes_loaded = load_themes();
    events();
    paint('schemas');
    paint('symbols');
    paint('endpoints');
    themes_loaded.then(() => { update_preview('symbols'); });
  });
});
