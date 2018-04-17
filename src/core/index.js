import window from '../window';
import * as util from '../util';
import Collection from '../collection';
import * as is from '../is';
import Promise from '../promise';
import define from '../define';

import addRemove from './add-remove';
import animation from './animation';
import events from './events';
import exportFormat from './export';
import layout from './layout';
import notification from './notification';
import renderer from './renderer';
import search from './search';
import style from './style';
import viewport from './viewport';

let Core = function( opts ){
  let cy = this;

  opts = util.extend( {}, opts );

  let container = opts.container;

  // allow for passing a wrapped jquery object
  // e.g. cytoscape({ container: $('#cy') })
  if( container && !is.htmlElement( container ) && is.htmlElement( container[0] ) ){
    container = container[0];
  }

  let reg = container ? container._cyreg : null; // e.g. already registered some info (e.g. readies) via jquery
  reg = reg || {};

  if( reg && reg.cy ){
    reg.cy.destroy();

    reg = {}; // old instance => replace reg completely
  }

  let readies = reg.readies = reg.readies || [];

  if( container ){ container._cyreg = reg; } // make sure container assoc'd reg points to this cy
  reg.cy = cy;

  let head = window !== undefined && container !== undefined && !opts.headless;
  let options = opts;
  options.layout = util.extend( { name: head ? 'grid' : 'null' }, options.layout );
  options.renderer = util.extend( { name: head ? 'canvas' : 'null' }, options.renderer );

  let defVal = function( def, val, altVal ){
    if( val !== undefined ){
      return val;
    } else if( altVal !== undefined ){
      return altVal;
    } else {
      return def;
    }
  };

  let _p = this._private = {
    container: container, // html dom ele container
    ready: false, // whether ready has been triggered
    options: options, // cached options
    elements: new Collection( this ), // elements in the graph
    listeners: [], // list of listeners
    aniEles: new Collection( this ), // elements being animated
    scratch: {}, // scratch object for core
    layout: null,
    renderer: null,
    destroyed: false, // whether destroy was called
    notificationsEnabled: true, // whether notifications are sent to the renderer
    minZoom: 1e-50,
    maxZoom: 1e50,
    zoomingEnabled: defVal( true, options.zoomingEnabled ),
    userZoomingEnabled: defVal( true, options.userZoomingEnabled ),
    panningEnabled: defVal( true, options.panningEnabled ),
    userPanningEnabled: defVal( true, options.userPanningEnabled ),
    boxSelectionEnabled: defVal( true, options.boxSelectionEnabled ),
    autolock: defVal( false, options.autolock, options.autolockNodes ),
    autoungrabify: defVal( false, options.autoungrabify, options.autoungrabifyNodes ),
    autounselectify: defVal( false, options.autounselectify ),
    styleEnabled: options.styleEnabled === undefined ? head : options.styleEnabled,
    zoom: is.number( options.zoom ) ? options.zoom : 1,
    pan: {
      x: is.plainObject( options.pan ) && is.number( options.pan.x ) ? options.pan.x : 0,
      y: is.plainObject( options.pan ) && is.number( options.pan.y ) ? options.pan.y : 0
    },
    animation: { // object for currently-running animations
      current: [],
      queue: []
    },
    hasCompoundNodes: false
  };

  this.createEmitter();

  // set selection type
  this.selectionType( options.selectionType );

  // init zoom bounds
  this.zoomRange({ min: options.minZoom, max: options.maxZoom });

  let loadExtData = function( extData, next ){
    let anyIsPromise = extData.some( is.promise );

    if( anyIsPromise ){
      return Promise.all( extData ).then( next ); // load all data asynchronously, then exec rest of init
    } else {
      next( extData ); // exec synchronously for convenience
    }
  };

  // start with the default stylesheet so we have something before loading an external stylesheet
  if( _p.styleEnabled ){
    cy.setStyle([]);
  }

  // create the renderer
  cy.initRenderer( options.renderer );

  let setElesAndLayout = function( elements, onload, ondone ){
    cy.notifications( false );

    // remove old elements
    let oldEles = cy.mutableElements();
    if( oldEles.length > 0 ){
      oldEles.remove();
    }

    if( elements != null ){
      if( is.plainObject( elements ) || is.array( elements ) ){
        cy.add( elements );
      }
    }

    cy.one( 'layoutready', function( e ){
      cy.notifications( true );
      cy.emit( e ); // we missed this event by turning notifications off, so pass it on

      cy.notify( {
        type: 'load',
        eles: cy.mutableElements()
      } );

      cy.one( 'load', onload );
      cy.emit( 'load' );
    } ).one( 'layoutstop', function(){
      cy.one( 'done', ondone );
      cy.emit( 'done' );
    } );

    let layoutOpts = util.extend( {}, cy._private.options.layout );
    layoutOpts.eles = cy.elements();

    cy.layout( layoutOpts ).run();
  };

  loadExtData([ options.style, options.elements ], function( thens ){
    let initStyle = thens[0];
    let initEles = thens[1];

    // init style
    if( _p.styleEnabled ){
      cy.style().append( initStyle );
    }

    // initial load
    setElesAndLayout( initEles, function(){ // onready
      cy.startAnimationLoop();
      _p.ready = true;

      // if a ready callback is specified as an option, the bind it
      if( is.fn( options.ready ) ){
        cy.on( 'ready', options.ready );
      }

      // bind all the ready handlers registered before creating this instance
      for( let i = 0; i < readies.length; i++ ){
        let fn = readies[ i ];
        cy.on( 'ready', fn );
      }
      if( reg ){ reg.readies = []; } // clear b/c we've bound them all and don't want to keep it around in case a new core uses the same div etc

      cy.emit( 'ready' );
    }, options.done );

  } );
};

let corefn = Core.prototype; // short alias

util.extend( corefn, {
  instanceString: function(){
    return 'core';
  },

  isReady: function(){
    return this._private.ready;
  },

  isDestroyed: function(){
    return this._private.destroyed;
  },

  ready: function( fn ){
    if( this.isReady() ){
      this.emitter().emit( 'ready', [], fn ); // just calls fn as though triggered via ready event
    } else {
      this.on( 'ready', fn );
    }

    return this;
  },

  destroy: function(){
    let cy = this;
    if( cy.isDestroyed() ) return;

    cy.stopAnimationLoop();

    cy.destroyRenderer();

    this.emit( 'destroy' );

    cy._private.destroyed = true;

    return cy;
  },

  hasElementWithId: function( id ){
    return this._private.elements.hasElementWithId( id );
  },

  getElementById: function( id ){
    return this._private.elements.getElementById( id );
  },

  hasCompoundNodes: function(){
    return this._private.hasCompoundNodes;
  },

  headless: function(){
    return this._private.renderer.isHeadless();
  },

  styleEnabled: function(){
    return this._private.styleEnabled;
  },

  addToPool: function( eles ){
    this._private.elements.merge( eles );

    return this; // chaining
  },

  removeFromPool: function( eles ){
    this._private.elements.unmerge( eles );

    return this;
  },

  container: function(){
    return this._private.container;
  },

  mount: function( container, rendererOptions ){
    if( container == null ){ return; }

    let cy = this;
    let _p = cy._private;
    let options = _p.options;

    let rOpts = rendererOptions ? rendererOptions : { name: 'canvas' };
    options.renderer = rOpts;

    if( !is.htmlElement( container ) && is.htmlElement( container[0] ) ){
      container = container[0];
    }

    cy.stopAnimationLoop();

    cy.destroyRenderer();

    _p.container = container;
    _p.styleEnabled = true;

    cy.initRenderer( rOpts );

    cy.startAnimationLoop();

    cy.style( options.style );

    cy.emit( 'mount' );

    return cy;
  },

  unmount: function(){
    let cy = this;

    cy.stopAnimationLoop();

    cy.destroyRenderer();

    cy.initRenderer( { name: 'null' } );

    cy.emit( 'unmount' );

    return cy;
  },

  options: function(){
    return util.copy( this._private.options );
  },

  json: function( obj ){
    let cy = this;
    let _p = cy._private;
    let eles = cy.mutableElements();

    if( is.plainObject( obj ) ){ // set

      cy.startBatch();

      if( obj.elements ){
        let idInJson = {};

        let updateEles = function( jsons, gr ){
          for( let i = 0; i < jsons.length; i++ ){
            let json = jsons[ i ];
            let id = json.data.id;
            let ele = cy.getElementById( id );

            idInJson[ id ] = true;

            if( ele.length !== 0 ){ // existing element should be updated
              ele.json( json );
            } else { // otherwise should be added
              if( gr ){
                json.group = gr;

                cy.add( json );
              } else {
                cy.add( json );
              }
            }
          }
        };

        if( is.array( obj.elements ) ){ // elements: []
          updateEles( obj.elements );

        } else { // elements: { nodes: [], edges: [] }
          let grs = [ 'nodes', 'edges' ];
          for( let i = 0; i < grs.length; i++ ){
            let gr = grs[ i ];
            let elements = obj.elements[ gr ];

            if( is.array( elements ) ){
              updateEles( elements, gr );
            }
          }
        }

        // elements not specified in json should be removed
        eles.stdFilter( function( ele ){
          return !idInJson[ ele.id() ];
        } ).remove();
      }

      if( obj.style ){
        cy.style( obj.style );
      }

      if( obj.zoom != null && obj.zoom !== _p.zoom ){
        cy.zoom( obj.zoom );
      }

      if( obj.pan ){
        if( obj.pan.x !== _p.pan.x || obj.pan.y !== _p.pan.y ){
          cy.pan( obj.pan );
        }
      }

      let fields = [
        'minZoom', 'maxZoom', 'zoomingEnabled', 'userZoomingEnabled',
        'panningEnabled', 'userPanningEnabled',
        'boxSelectionEnabled',
        'autolock', 'autoungrabify', 'autounselectify'
      ];

      for( let i = 0; i < fields.length; i++ ){
        let f = fields[ i ];

        if( obj[ f ] != null ){
          cy[ f ]( obj[ f ] );
        }
      }

      cy.endBatch();

      return this; // chaining
    } else if( obj === undefined ){ // get
      let json = {};

      json.elements = {};
      eles.forEach( function( ele ){
        let group = ele.group();

        if( !json.elements[ group ] ){
          json.elements[ group ] = [];
        }

        json.elements[ group ].push( ele.json() );
      } );

      if( this._private.styleEnabled ){
        json.style = cy.style().json();
      }

      let options = _p.options;

      json.zoomingEnabled = _p.zoomingEnabled;
      json.userZoomingEnabled = _p.userZoomingEnabled;
      json.zoom = _p.zoom;
      json.minZoom = _p.minZoom;
      json.maxZoom = _p.maxZoom;
      json.panningEnabled = _p.panningEnabled;
      json.userPanningEnabled = _p.userPanningEnabled;
      json.pan = util.copy( _p.pan );
      json.boxSelectionEnabled = _p.boxSelectionEnabled;
      json.renderer = util.copy( options.renderer );
      json.hideEdgesOnViewport = options.hideEdgesOnViewport;
      json.textureOnViewport = options.textureOnViewport;
      json.wheelSensitivity = options.wheelSensitivity;
      json.motionBlur = options.motionBlur;

      return json;
    }
  },

  scratch: define.data( {
    field: 'scratch',
    bindingEvent: 'scratch',
    allowBinding: true,
    allowSetting: true,
    settingEvent: 'scratch',
    settingTriggersEvent: true,
    triggerFnName: 'trigger',
    allowGetting: true
  } ),

  removeScratch: define.removeData( {
    field: 'scratch',
    event: 'scratch',
    triggerFnName: 'trigger',
    triggerEvent: true
  } )

} );

corefn.$id = corefn.getElementById;

[
  addRemove,
  animation,
  events,
  exportFormat,
  layout,
  notification,
  renderer,
  search,
  style,
  viewport,
].forEach( function( props ){
  util.extend( corefn, props );
} );

export default Core;
