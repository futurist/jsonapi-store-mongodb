'use strict'
var _ = {
  omit: require('lodash.omit')
}
var async = require('async')
var debug = require('./debugging')
var mongodb = require('mongodb')
var co = require('co')
var joi = require('joi')
var querystring = require('querystring')
var util = require('util')
var objutil = require('objutil')
var helper = require('./helper')
var autoIncrement = require('mongodb-autoincrement')

var keys = Object.keys

var MongoStore = module.exports = function MongoStore (config) {
  this._config = config
  this._initQueue = []
}

/**
   Handlers readiness status. This should be set to `true` once all handlers are ready to process requests.
*/
MongoStore.prototype.ready = false

MongoStore._mongoUuid = function (uuid) {
  return new mongodb.Binary(uuid, mongodb.Binary.SUBTYPE_UUID)
}

MongoStore._isRelationshipAttribute = function (attribute) {
  return attribute._settings && (attribute._settings.__one || attribute._settings.__many)
}

MongoStore._toMongoDocument = function (resource) {
  var document = _.omit(resource, function (value) { return value === undefined })
  document._id = MongoStore._mongoUuid(document.id)
  return document
}

MongoStore._getRelationshipAttributeNames = function (attributes) {
  var attributeNames = Object.getOwnPropertyNames(attributes)
  var relationshipAttributeNames = attributeNames.reduce(function (partialAttributeNames, name) {
    var attribute = attributes[name]
    if (MongoStore._isRelationshipAttribute(attribute)) {
      return partialAttributeNames.concat(name)
    }
    return partialAttributeNames
  }, [])
  return relationshipAttributeNames
}

MongoStore.prototype._getAttributesConfig = function (request) {
  var self = this
  var _resources = self.resourceConfig._resources
  var colName = request.params.type
  var attributesConfig = _resources[colName].attributes
  return attributesConfig
}

MongoStore.prototype._getSearchCriteria = function (request) {
  var self = this

  if (request.params._id) return { _id: request.params._id }
  if (request.params.id) return { id: request.params.id }
  if (!request.params.filter) return { }

  var attributes = self._getAttributesConfig(request)

  var criteria = Object.keys(request.params.filter).map(function (attribute) {
    if(attribute.indexOf('/')>0) return {}
    var attributeConfig = attributes[attribute]
    // If the filter attribute doens't exist, skip it
    if (!attributeConfig) return null
    // external table already processed using aggregate

    const settings = attributeConfig._settings
    if (settings) {
      const relation = settings.__one || settings.__many
      const tkey = settings.__tkey

      if (relation && tkey) return null
    }

    var values = request.params.filter[attribute]
    // Relationships need to be queried via .id
    if (attributeConfig._settings) {
      // skip joi.attempt validation
      attributeConfig = joi.any().allow(['', null])
      attribute += '.id'
      // Filters on nested resources should be skipped
      if (values instanceof Object) return null
    }

    // Coerce values to an array to simplify the logic
    if (!(values instanceof Array)) values = [ values ]
    values = values.map(val => {
      return helper.str2Query(val, attributeConfig)
    }).map(function (qval) {
      var tmp = { }
      tmp[attribute] = qval
      return tmp
    })

    return { $or: values }
  }).filter(function (value) {
    return value !== null
  })

  if (criteria.length === 0) {
    return { }
  }
  return { $and: criteria }
}

MongoStore._notFoundError = function (type, id) {
  return {
    status: '404',
    code: 'ENOTFOUND',
    title: 'Requested resource does not exist',
    detail: 'There is no ' + type + ' with id ' + id
  }
}

MongoStore.prototype._createIndexesForRelationships = function (collection, relationshipAttributeNames) {
  var index = relationshipAttributeNames.reduce(function (partialIndex, name) {
    partialIndex[name + '.id'] = 1
    return partialIndex
  }, {})
  collection.createIndex(index)
}

MongoStore.prototype._applySort = function (request, cursor, extraField) {
  var self = this
  var attributes = self._getAttributesConfig(request)
  var qs = querystring.parse(request.route.query)

  if (!qs.sort) return cursor
  var sortParam = { }

  ;[].concat(qs.sort).forEach(attribute => {
    let order = 1
    attribute = String(attribute).valueOf()
    if (attribute[0] === '>') {
      attribute = attribute.substr(1)
    } else if (attribute[0] === '<') {
      order = -1
      attribute = attribute.substr(1)
    }

    // it's tkey external keys: charger
    const attributeConfig = attributes[attribute]
    const settings = attributeConfig && attributeConfig._settings
    if (settings) {
      const relation = settings.__one || settings.__many
      const tkey = settings.__tkey
      if (relation && tkey) {
        attribute = '__' + relation + '/' + attribute + '.' + tkey
      }
    }

    const extra = extraField.find(v=>v.path == attribute)
    if(extra) attribute = extra.key + '.' + extra.field
    sortParam[attribute] = order
  })

  console.log('***sort:', sortParam)

  return cursor.sort(sortParam)
}

MongoStore.prototype._applyPagination = function (request, cursor) {
  if (!request.params.page) return cursor

  return cursor.skip(request.params.page.offset).limit(request.params.page.limit)
}

/**
   Initialise gets invoked once for each resource that uses this handler.
*/
MongoStore.prototype.initialise = function (resourceConfig) {
  var self = this
  if (!self._config.url) {
    return console.error('MongoDB url missing from configuration')
  }
  var initResource = function () {
    var resourceName = resourceConfig.resource
    var collection = self._db.collection(resourceName)
    self._createIndexesForRelationships(collection, self.relationshipAttributeNames)
    self.ready = true
    self.on_initialise && self.on_initialise(resourceName, collection)
  }

  self.resourceConfig = resourceConfig
  self.relationshipAttributeNames = MongoStore._getRelationshipAttributeNames(resourceConfig.attributes)

  if (!self._db) {
    self._initQueue.push(initResource)
    if (self._initQueue.length == 1) {
      mongodb.MongoClient.connect(self._config.url).then(function (db) {
        self._db = db
        if (self.on_open) self.on_open(null, db)
      }).catch(function (err) {
        if (self.on_open) self.on_open(err)
        return console.error('error connecting to MongoDB:', err.message)
      }).then(function () {
        while (self._initQueue.length) self._initQueue.shift()()
      })
    }
  } else {
    initResource()
  }
}

/**
   Drops the database if it already exists and populates it with example documents.
*/
MongoStore.prototype.populate = function (callback) {
  var self = this
  self._db.dropDatabase(function (err) {
    if (err) return console.error('error dropping database', err.message)
    async.each(self.resourceConfig.examples, function (document, cb) {
      self.create({ params: {} }, document, cb)
    }, function (error) {
      if (error) console.error('error creating example document:', error)
      return callback()
    })
  })
}

/**
   Search for a list of resources, give a resource type.
*/
MongoStore.prototype.search = function (request, callback) {
  var self = this
  var _resources = self.resourceConfig._resources
  var colName = request.params.type
  var attributes = _resources[colName].attributes
  var collection = self._db.collection(colName)
  var formType = self._formtype[colName]
  const tableLookups = {}
  const extraField = []
  const inheritedObj = {}  // inherited hash table
  const existFormTypes = []
  ;(request.safeHeaders['exist-formtypes']||'').split(',').forEach(v=>{
    if(!v) return
    // form_charger@2
    const [name, version] = v.split('@')  // [name, version]
    // console.log(name, version, self._formtype[name])
    const form = self._formtype[name]
    if(form && form.version==version) existFormTypes.push(name)
  })

  // check base form staled or not
  if(existFormTypes.indexOf(colName)<0) tableLookups[colName] = self._formtype[colName]

  // console.log('**query: ', util.inspect(request.safeHeaders, {depth:null}))

  // helper.logAssert(
  //   helper.getFormTree('~/maker/leader/name'.split('/'), 'form_lahuojihua_list', _resources),
  //   (v,a)=>a.deepEqual(v.map(x=>x.field), ['parentID', 'maker', 'leader'])
  // )

  if (formType) {
    // parent table is optional...
    var parentTable = formType.table
    // noextra=1 will ignore stage tkey
    var tkeyArray = request.params.noextra ? [] : helper.getTkey(formType)
    // populate all inherited fields
    for(var i in formType.templateRef) {
      const inherited = formType.templateRef[i].attrs.inherited
      if (inherited) {
        inheritedObj[inherited] = {
          name: i,
          joiType: attributes[i],
          dom: formType.template[i],
          ref: formType.templateRef[i]
        }
        tkeyArray.push(inherited)
      }
    }
  }
  try {
    var criteria = self._getSearchCriteria(request)
  } catch (e) {
    console.log(e)
    return callback({
      status: '500',
      code: 'TypeError',
      title: 'TypeError',
      detail: '输入错误'
    })
  }
  debug('search', JSON.stringify(criteria))
  // console.log(Object.keys(request.resourceConfig), request.resourceConfig.attributes)
  // console.log(self.relationshipAttributeNames, Object.keys(self.resourceConfig.attributes), 234)
  var query = [
    {$match: criteria}
    // {$lookup: {from: "users",localField: "uid",foreignField: "uid",as: "userData"}},
    // {$sort: {'userData.name': 1}}
  ]

  // get includes
  var includes = request.params.include && request.params.include.split(',')
  if (includes && includes.indexOf('parentID')) {
    // have parent foreign keys
  }

  const relationAlias = {}
  const parent = request.params.parent
  const filter = request.params.filter || {}

  if (tkeyArray && tkeyArray.length) {
    const _query2 = []
    const _filter2 = []
    tkeyArray.forEach(v => {
      v = v.trim()
      if (!v) return
      const segment = v.split('/')
      if(segment.length<2) return
      const fields = segment.pop().split(',')
      // tree: {field, table, tkey, form:{attributes}}
      const tree = helper.getFormTree(segment, colName, _resources)
      // last segment always field name, not formtype
      // console.log(tree.length, segment.length)
      if (tree.length == segment.length) {
        helper.buildQueryFromTree(tree).forEach(v => {
          if (_query2.findIndex(x => x.as == v.as) < 0) {
            _query2.push(v)
          }
        })
        const resolvedFields = tree.map(v=>v.field)
        const forms = tree.map(v=>v.table)
        fields.forEach(field=>{
          const key = '__' + resolvedFields.join('/')
          // extraField[segment.concat(field).join('/')] = helper.last(tree).form.attributes
          const arr = field.split(':')
          const title = arr[1]
          field = arr[0].trim()
          const path = segment.concat(field).join('/')
          const inherit = inheritedObj[path]
          extraField.push({
            key: key,
            field: field,
            title: title,
            table: helper.last(forms),
            path: path,
            inherit: inherit ? inherit.name : null
          })
          if(filter[v]) {
            const matchp = {}
            const _f = filter[v]
            const attributeConfig = helper.last(tree).form.attributes[field]
            if (_f[0] == ':') {
              // fizzy match
              matchp[key + '.' + field] = {$regex: helper.joiCastValue(_f, 1, attributeConfig), $options: 'i'}
            } else {
              matchp[key + '.' + field] = helper.joiCastValue(_f, 0, attributeConfig)
            }
            // console.log({$match: { [key]: {$elemMatch: matchp} } }, matchp)

            // _filter2 is {__parentID: [{$match...}, ...]}
            _filter2[key] = _filter2[key] || []
            _filter2[key].push({$match: matchp })
          }
        })
      }
    })
    console.log(_filter2, 333)
    // console.log(_query2, tkeyArray)
    _query2.forEach(v => {
      query.push(
        { '$lookup': v },
        { '$unwind': {path: '$' + v.as, preserveNullAndEmptyArrays: true }}
      )
      // add filter for this table
      if(Array.isArray(_filter2[v.as])) [].push.apply(query, _filter2[v.as])
      if(existFormTypes.indexOf(v.from)<0) tableLookups[v.from] = self._formtype[v.from]
    })
  }

  keys(attributes).forEach(function (attr) {
    const settings = attributes[attr]._settings
    if (settings) {
      const relation = settings.__one || settings.__many
      const tkey = settings.__tkey || 'id'
      if (relation && tkey) {
        // don't pull formtype
        if(relation=='formtype') return
        // console.log(colName, relation, tkey)
        // reuse the exist $lookup value
        const existQuery = query.find(v => {
          const q = v.$lookup
          return q &&
            q.form == relation &&
            q.localField == attr &&
            q.foreignField == tkey
        })

        const as = '__' + relation + '/' + attr
        if (!existQuery) {
          query.push(
            // result name is __lahuojihua, __ indicate foreign
            {$lookup: {from: relation, localField: attr + '.id', foreignField: 'id', as }},
            {"$unwind":{path: '$' + as, includeArrayIndex: as + '_index', preserveNullAndEmptyArrays: true}}
          )
          if(existFormTypes.indexOf(relation)<0) tableLookups[relation] = self._formtype[relation]
        }

        // console.log(tableLookups)

        const externalTypeDefs = _resources[relation]
        const attributes = externalTypeDefs ? externalTypeDefs.attributes : {}
        const matchp = {}
        const filter = request.params.filter && request.params.filter[attr]
        if (filter) {
          if (filter[0] == ':') {
            // fizzy match
            matchp[as + '.' + tkey] = {$regex: helper.joiCastValue(filter, 1, attributes[tkey]), $options: 'i'}
          } else {
            matchp[as + '.' + tkey] = helper.joiCastValue(filter, 0, attributes[tkey])
          }

          query.push({$match: matchp })
        }
      }
    }
  })

  console.log(colName, JSON.stringify(query), request.params.filter, request.params.sort, request.cookies, 1234)

  async.parallel({
    resultSet: function (asyncCallback) {
      // var cursor = collection.find(criteria, { _id: 0 });
      var cursor = collection.aggregate(query)
      self._applySort(request, cursor, extraField)
      self._applyPagination(request, cursor)
      return cursor.toArray(asyncCallback)
    },
    totalRows: function (asyncCallback) {
      return collection.find(criteria, { _id: 0 }).count(asyncCallback)
    }
  }, function (err, results) {
    return callback(err, results.resultSet, results.totalRows, {
      formtypes: tableLookups,
      extraField
    })
  })
}

/**
   Find a specific resource, given a resource type and and id.
*/
MongoStore.prototype.find = function (request, callback) {
  var collection = this._db.collection(request.params.type)
  var documentId = MongoStore._mongoUuid(request.params.id)
  debug('findOne', JSON.stringify({ _id: documentId }))
  request.params.noextra = 1
  // console.log('findOne', JSON.stringify(request.params))
  this.search(request, function(err, result, total, meta) {
    if (err || !result || total<1) {
      return callback(MongoStore._notFoundError(request.params.type, request.params.id))
    }
    return callback(null, result[0], meta)
  })
  return

  collection.findOne({ _id: documentId }, { _id: 0 }, function (err, result) {
    if (err || !result) {
      return callback(MongoStore._notFoundError(request.params.type, request.params.id))
    }
    return callback(null, result)
  })
}

/**
   Create (store) a new resource give a resource type and an object.
*/
MongoStore.prototype.create = co.wrap(function* (request, newResource, callback) {
  var self = this
  if (self.before_create) {
    try { yield self.before_create(newResource.type, newResource) } catch (e) {
      debug(e, 'create cancel')
      return callback({
        status: '500',
        code: 'Internal Server Error',
        title: 'Resource cannot be created',
        detail: e
      })
    }
  }
  var col = newResource.type
  var collection = this._db.collection(col)
  var document = MongoStore._toMongoDocument(newResource)
  debug('insert', JSON.stringify(document))
  // this will insert into [counters] collection, with below data
  // { "_id" : "form_colName_ID", "field" : "_id", "seq" : 1 }
  autoIncrement.getNextSequence(this._db, col + '_ID', function (e, ID) {
    if (e) {
      debug(e, 'ID generate error')
      return callback({
        status: '500',
        code: 'Internal Server Error',
        title: 'Resource cannot be created',
        detail: e
      })
    }

    document.ID = ID

    collection.insertOne(document, function (err) {
      if (err) return callback(err)
      collection.findOne(document, { _id: 0 }, function (err, doc) {
        if (self.after_create) return self.after_create.call(self, err, doc, function () { callback(err, doc) })
        callback(err, doc)
      })
    })
  })
})

/**
   Delete a resource, given a resource type and an id.
*/
MongoStore.prototype.delete = co.wrap(function* (request, callback) {
  var self = this
  if (self.before_delete) {
    try { yield self.before_delete(request.params.type, request.params.id) } catch (e) {
      debug(e, 'delete cancel')
      return callback({
        status: '500',
        code: 'Internal Server Error',
        title: 'Resource cannot be deleted',
        detail: e
      })
    }
  }
  var collection = this._db.collection(request.params.type)
  var documentId = MongoStore._mongoUuid(request.params.id)
  collection.deleteOne({ _id: documentId }, function (err, result) {
    if (err) return callback(err)
    if (result.deletedCount === 0) {
      return callback(MongoStore._notFoundError(request.params.type, request.params.id))
    }
    if (self.after_delete) self.after_delete.call(self, err, result, request.params.type, request.params.id, function () { callback(err, result) })
    return callback(err, result)
  })
})

/**
   Update a resource, given a resource type and id, along with a partialResource.
   partialResource contains a subset of changes that need to be merged over the original.
*/
MongoStore.prototype.update = co.wrap(function* (request, partialResource, callback) {
  // tutpoint: using co.wrap to instead of normal function, should callback with Promise!
  var self = this
  if (self.before_update) {
    try { yield self.before_update(request.params.type, request.params.id, partialResource) } catch (e) {
      debug(e, 'update cancel')
      return callback({
        status: '500',
        code: 'Internal Server Error',
        title: 'Resource cannot be updated',
        detail: e
      })
    }
  }
  var getColPromise = new Promise(function (resolve, reject) {
    self._db.collection(request.params.type, {strict: true}, function (err, col) {
      if (err) {
        var msg = {
          status: '500',
          code: 'Internal Server Error',
          title: 'Collection not found',
          detail: err
        }
        callback(msg)
        return reject(msg)
      } else {
        return resolve(col)
      }
    })
  })
  var collection = yield getColPromise
  var documentId = MongoStore._mongoUuid(request.params.id)
  var partialDocument = _.omit(partialResource, function (value) { return value === undefined })
  debug('findOneAndUpdate', JSON.stringify(partialDocument))
  collection.findOne({_id: documentId}, {fields: { _id: 0 }}, function (e, oldDoc) {
    collection.findOneAndUpdate({
      _id: documentId
    }, {
      $set: partialDocument
    }, {
      returnOriginal: false,
      projection: { _id: 0 }
    }, function (err, result) {
      if (err) {
        debug('err', JSON.stringify(err))
        return callback(err)
      }

      if (!result || !result.value) {
        return callback(MongoStore._notFoundError(request.params.type, request.params.id))
      }

      debug('result', JSON.stringify(result))
      if (self.after_update) return self.after_update.call(self, null, oldDoc, result.value, function () { return callback(null, result.value) })
      return callback(null, result.value)
    })
  })
})
