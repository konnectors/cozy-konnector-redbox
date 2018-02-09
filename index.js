const moment = require('moment')
const bluebird = require('bluebird')
const cheerio = require('cheerio')

const {log, BaseKonnector, saveBills, request, retry} = require('cozy-konnector-libs')

let rq = request({
  cheerio: true,
  json: false,
  jar: true,
  // debug: true,
  headers: {}
})

module.exports = new BaseKonnector(function fetch (fields) {
  return retry(getToken, {
    interval: 5000,
    throw_original: true
  })
  .then(token => logIn(token, fields))
  .then(() => retry(fetchBillsAttempts, {
    interval: 5000,
    throw_original: true,
    // do not retry if we get the LOGIN_FAILED error code
    predicate: err => err.message !== 'LOGIN_FAILED'
  }))
  .then(entries => saveBills(entries, fields.folderPath, {
    timeout: Date.now() + 60 * 1000,
    identifiers: 'sfr'
  }))
  .catch(err => {
    // Connector is not in error if there is not entry in the end
    // It may be simply an empty account
    if (err.message === 'NO_ENTRY') return []
    throw err
  })
})

// Procedure to get the login token
function getToken () {
  log('info', 'Logging in on Sfr RED Website...')
  return rq('https://www.sfr.fr/cas/login?service=https://www.red-by-sfr.fr/accueil/j_spring_cas_security_check&theme=espaceclientred#redclicid=X_Menu_EspaceClient')
  .then($ => $('input[name=lt]').val())
  .then(token => {
    log('debug', token, 'TOKEN')
    if (!token) throw new Error('BAD_TOKEN')
    return token
  })
}

function logIn (token, fields) {
  return rq({
    method: 'POST',
    url: 'https://www.sfr.fr/cas/login?domain=espaceclientred&service=https://www.red-by-sfr.fr/accueil/j_spring_cas_security_check#sfrclicid=EC_mire_Me-Connecter',
    form: {
      lt: token,
      execution: 'e1s1',
      _eventId: 'submit',
      username: fields.login,
      password: fields.password,
      identifier: ''
    }
  })
  .then($ => {
    // check that the login is OK
    const badLogin = $('#username').length > 0
    if (badLogin) throw new Error('bad login')
  })
  .catch(err => {
    log('warn', err.message, 'Error while logging in')
    throw new Error('LOGIN_FAILED')
  })
}

function fetchBillsAttempts () {
  return fetchBillingInfo()
  .then(parsePage)
  .then(entries => {
    if (entries.length === 0) throw new Error('NO_ENTRY')
    return entries
  })
}

function fetchBillingInfo () {
  log('info', 'Fetching bill info')
  return rq({
    url: 'https://espace-client-red.sfr.fr/facture-fixe/consultation',
    resolveWithFullResponse: true,
    maxRedirects: 5 // avoids infinite redirection to facture-mobile if any
  })
  .then(response => {
    // check that the page was not redirected to another sfr service
    if (response.request.uri.path !== '/facture-fixe/consultation' || response.request.uri.hostname !== 'espace-client-red.sfr.fr') {
      // this is the case where the user identified himself with other sfr login
      log('error', 'This is not red box identifier')
      throw new Error('LOGIN_FAILED')
    }

    return response.body
  })
}

function parsePage ($) {
  const result = []
  moment.locale('fr')
  const baseURL = 'https://espace-client-red.sfr.fr'

  // handle the special case of the first bill
  const $firstBill = $('#lastFacture')
  const firstBillUrl = $firstBill.find('a.sr-chevron').attr('href')

  if (firstBillUrl) {
    const fields = $firstBill.find('.sr-container-content').eq(0).find('span')
    const firstBillDate = moment(fields.eq(1).text().trim(), 'DD/MM/YYYY')
    const price = fields.eq(2).text().trim().replace('€', '').replace(',', '.')

    const bill = {
      date: firstBillDate.toDate(),
      amount: parseFloat(price),
      fileurl: `${baseURL}${firstBillUrl}`,
      filename: getFileName(firstBillDate),
      vendor: 'SFR RED BOX'
    }

    result.push(bill)
  } else {
    log('info', 'wrong url for first PDF bill.')
  }

  return bluebird.mapSeries(Array.from($('table.sr-multi-payment tbody tr')), tr => {
    let link = $(tr).find('td').eq(1).find('a')
    if (link.length === 1) {
      link = baseURL + link.attr('href')
      return rq(link)
      .then($ => $('.sr-container-wrapper-m').eq(0).html())
    } else {
      return false
    }
  })
  .then(list => list.filter(item => item))
  .then(list => list.map(item => {
    const $ = cheerio.load(item)
    const fileurl = $('a.sr-chevron').attr('href')
    const fields = $('.sr-container-box-M').eq(0).find('span')
    const date = moment(fields.eq(1).text().trim(), 'DD/MM/YYYY')
    const price = fields.eq(2).text().trim().replace('€', '').replace(',', '.')
    if (price) {
      const bill = {
        date: date.toDate(),
        amount: parseFloat(price),
        fileurl: `${baseURL}${fileurl}`,
        filename: getFileName(date),
        vendor: 'SFR RED BOX'
      }
      return bill
    } else return null
  }))
  .then(list => list.filter(item => item))
  .then(bills => {
    if (result.length) bills.unshift(result[0])
    return bills
  })
}

function getFileName (date) {
  return `${date.format('YYYY_MM')}_SfrRed.pdf`
}
