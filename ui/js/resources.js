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
      let tb = $('tbody',list(kind));
      $('tr:not(.new)',tb).remove();
      $('resource',res).each((_,r) => {
        let name = $(r).text();
        let tr = from_template(kind,'row');
        tr.attr('data-name',name);
        $('[data-class=name]',tr).text(base(name));
        if (name == current[kind].name) { tr.addClass('selected'); }
        if (kind == 'symbols') { thumbnail(name,$('[data-class=icon]',tr)); }
        tb.append(tr);
      });
    },
    error: () => {
      $('tr:not(.new)',$('tbody',list(kind))).remove();
    }
  });
} //}}}
function thumbnail(name,td) { //{{{
  // drawn like the narrow preview, cut to the 30x30 of the symbol
  $.ajax({
    type: 'GET',
    url: server + 'symbols/' + name,
    dataType: 'text',
    success: (res) => {
      let icon;
      try {
        icon = $XR(res);
      } catch(e) {
        td.empty().append(from_template('symbols','broken'));
        return;
      }
      themes_loaded.then(() => {
        if (!adaptors['extended']) { return; }
        td.empty();
        try {
          let g = draw_symbol(td,'extended','',icon);
          let pos = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.children('g').attr('transform'));
          let svg = $('svg',td);
          svg.attr('viewBox',pos[1] + ' ' + pos[2] + ' 30 30');
          svg.removeAttr('width').removeAttr('height');
        } catch(e) {
          td.empty().append(from_template('symbols','broken').attr('title',e.message));
        }
      });
    }
  });
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
    success: (res) => {
      current[kind].name = name;
      $('tbody tr',list(kind)).removeClass('selected');
      row(kind,name).addClass('selected');
      let det = detail(kind);
      $('div.nothing',det).addClass('hidden');
      $('div.detail',det).removeClass('hidden');
      $('div.head h1 span.name',det).text(base(name));
      if (kind == 'schemas') {
        editor_set(current.schemas.editors.schema,res.replace(/\s+$/,''));
        current.schemas.orig.schema = editor_get(current.schemas.editors.schema);
      } else {
        load_icon(res);
      }
      update_state(kind);
      update_preview(kind);
    },
    error: (xhr) => { failed('load',target,name,xhr.status); }
  });
  if (name != current[kind].name) {
    leave_ok(kind,target,load);
  } else {
    load();
  }
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
    if (kind == 'symbols') {
      thumbnail(cur.name,$('td[data-class=icon]',row(kind,cur.name)));
    }
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
      paint(kind);
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
      success: () => {
        if (current[kind].name == name) {
          current[kind].name = undefined;
          current[kind].orig = {};
          $('div.nothing',detail(kind)).removeClass('hidden');
          $('div.detail',detail(kind)).addClass('hidden');
        }
        paint(kind);
      },
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
            $.ajax({
              type: 'DELETE',
              url: server + kind + '/' + name,
              success: () => {
                if (current[kind].name == name) {
                  current[kind].name = nname;
                  $('div.head h1 span.name',detail(kind)).text(base(nname));
                }
                paint(kind);
              },
              error: (xhr) => { failed('delete',target,name,xhr.status); }
            });
          } else {
            paint(kind);
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
    let cells = $('#iconpreview td[data-state]');
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
    cells.each((_,td) => {
      let theme = $(td).closest('tr').attr('data-theme');
      if (!adaptors[theme]) { return; }
      try {
        draw_symbol($(td),theme,$(td).attr('data-state'),icon);
      } catch(e) {
        $(td).text(e.message);
      }
    });
  }
} //}}}
function draw_symbol(td,theme,state,icon) { //{{{
  // drawn by wfadaptor.js like a call with an endpoint that has this icon,
  // the state class is set like format_visual_set in the cockpit does
  let ill = adaptors[theme].illustrator;
  let svg = $(document.createElementNS(SVGNS,'svg'));
  td.append(svg); // has to be in the document, so that it can be measured
  ill.get_symbol = () => icon;
  ill.set_svg_container(svg);
  ill.clear();
  let block = { 'max': { 'row': 1, 'col': 0 }, 'endnodes': [], 'svg': $X('<g class="group" xmlns="' + SVGNS + '"/>') };
  let g = ill.draw.draw_symbol('call', 'preview-' + (uid++), $('#iconpreview').attr('data-label'), 1, 1, 1, 0, block.svg, true, { 'element-endpoint': 'preview' }, {});
  g.off();
  if (state) {
    g.children('g').attr('class','activities ' + state);
  } else { // as drawn, without any state class
    g.children('g').removeAttr('class');
  }
  ill.set_svg(block);
  // only the task: set_svg leaves about the same room on all sides of it (e.g. for the hover mark), 2px are kept
  let [tx,ty] = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.children('g').attr('transform')).slice(1).map(Number);
  let w = svg.attr('width') - 2 * tx + 4;
  let h = svg.attr('height') - 2 * ty + 4;
  svg.attr({ 'viewBox': (tx - 2) + ' ' + (ty - 2) + ' ' + w + ' ' + h, 'width': w, 'height': h });
  return g;
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
      success: () => { new WfAdaptor(themes_base + t + '/theme.js',(adaptor) => { adaptors[t] = adaptor; resolve(); }); },
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
    paint('schemas');
    paint('symbols');
    themes_loaded.then(() => { update_preview('symbols'); });
  });
});
