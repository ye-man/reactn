import Callback from './typings/callback';
import {
  LocalReducer, GlobalReducer, Reducers, RemoveAddedReducer
} from './typings/reducer';
import objectGetListener from './utils/object-get-listener';
import Transaction from './utils/transaction';



// AsynchronousNewGlobalState is an interface so that NewGlobalState does not
//   circularly reference itself.
// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface AsynchronousNewGlobalState<Shape>
  extends Promise<NewGlobalState<Shape>> { }

interface FunctionalNewGlobalState<Shape> {
  (globalState: Shape): NewGlobalState<Shape>;
}

export type NewGlobalState<Shape> =
  AsynchronousNewGlobalState<Shape> |
  FunctionalNewGlobalState<Shape> |
  SynchronousNewGlobalState<Shape>;

type PartialState<Shape> = Shape extends Record<string, any> ? Partial<Shape> : Shape;

export type PropertyListener = () => void;

type RemoveAddedCallback = () => boolean;

type SynchronousNewGlobalState<Shape> = null | PartialState<Shape> | void;



const INVALID_NEW_GLOBAL_STATE: Error = new Error(
  'Global state must be a function, null, object, or Promise.'
);

const MAX_SAFE_INTEGER = 9007199254740990;



export default class GlobalStateManager<GS extends {} = Record<string, any>> {

  private _callbacks: Set<Callback<GS>> = new Set();
  private _initialState: GS;
  private _propertyListeners: Map<keyof GS, Set<PropertyListener>> = new Map();
  private _reducers: Map<string, GlobalReducer<GS>> = new Map();
  private _state: GS;
  private _transactionId: number = 0;
  private _transactions: Map<number, Transaction<GS>> = new Map();

  public constructor(initialState: GS = Object.create(null)) {
    this._initialState = Object.assign(
      Object.create(null),
      initialState,
    );
    this.reset();
  }

  public addCallback(callback: Callback<GS>): RemoveAddedCallback {
    this._callbacks.add(callback);
    return (): boolean =>
      this.removeCallback(callback);
  }

  // Map component instance to a state property.
  public addPropertyListener(
    property: keyof GS,
    propertyListener: PropertyListener,
  ): void {

    // If property listeners already exist for this property,
    //   add this one to the set.
    if (this._propertyListeners.has(property)) {
      this._propertyListeners.get(property).add(propertyListener);
    }

    // If property listeners don't already exist for this property,
    //   create a set of property listeners that includes this one.
    else {
      this._propertyListeners.set(property, new Set([ propertyListener ]));
    }
  }

  public addReducer(name: string, localReducer: LocalReducer<GS>): RemoveAddedReducer {
    this._reducers.set(name, this.createReducer(localReducer));
    return (): boolean =>
      this.removeReducer(name);
  }

  // Begin a transaction.
  public beginTransaction(): number {
    this._transactionId = (this._transactionId + 1) % MAX_SAFE_INTEGER;
    this._transactions.set(this._transactionId, new Transaction());
    return this._transactionId;
  }

  // Commit a transaction.
  public commit(transactionId: number): void {
    const transaction: Transaction<GS> = this._transactions.get(transactionId);

    // Delete state properties.
    for (const property of transaction.voidProperties) {
      delete this._state[property];
    }

    // Commit all state changes.
    for (const [ property, value ] of transaction.properties.entries()) {
      this._state[property] = value;
    }

    // Force update all components that were a part of this transaction.
    for (const propertyListener of transaction.propertyListeners) {
      propertyListener();
    }

    // Clean up this transaction.
    this._transactions.delete(transactionId);

    // Call each global callback.
    for (const callback of this._callbacks) {

      // Delay these until after the current transaction has deleted?
      this.set(callback(this.state));
    }
  }

  public createReducer(localReducer: LocalReducer<GS>): GlobalReducer<GS> {
    return (...args: any[]): Promise<GS> =>
      this.set(
        localReducer(this.state, ...args),
      );
  }

  public getReducer(reducer: string): GlobalReducer<GS> {
    return this._reducers.get(reducer);
  }

  public get reducers(): Reducers<GS> {
    const reducers = Object.create(null);
    for (const [ name, reducer ] of this._reducers.entries()) {
      reducers[name] = reducer;
    }
    return reducers;
  }

  // Share whether the global state has a property listener.
  // Used in unit testing to prove whether component unmounting has occurred
  //   successfully.
  /*
  hasPropertyListener(property: PropertyListener | string): boolean {
    if (typeof property === 'string') {
      return this._propertyListeners.has(property);
    }
    for (const propertyListeners of this._propertyListeners.values()) {
      for (const propertyListener of propertyListeners) {
        if (propertyListener === property) {
          return true;
        }
      }
    }
    return false;
  }
  */

  public hasReducer(reducer: string): boolean {
    return this._reducers.has(reducer);
  }

  public removeCallback(callback: Callback<GS>): boolean {
    return this._callbacks.delete(callback);
  }

  // Unmap a component instance from all state properties.
  public removePropertyListener(propertyListener: PropertyListener): boolean {
    let removed = false;

    // Remove this property listener from the global state.
    for (const propertyListeners of this._propertyListeners.values()) {
      removed = removed || propertyListeners.delete(propertyListener);
    }

    // Remove this property listener from currently-executing transactions.
    for (const transaction of this._transactions.values()) {
      transaction.deletePropertyListener(propertyListener);
    }

    return removed;
  }

  public removeReducer(reducer: string): boolean {
    return this._reducers.delete(reducer);
  }

  // Reset the global state.
  public reset(): void {
    this._callbacks.clear();
    this._propertyListeners.clear();
    this._reducers.clear();
    this._state = Object.assign(
      Object.create(null),
      this._initialState,
    );
    this._transactionId = 0;
    this._transactions.clear();
  }

  // Set any type of state change.
  public set(any: NewGlobalState<GS>): Promise<GS> {

    // No changes, e.g. getDerivedGlobalFromProps.
    if (
      any === null ||
      typeof any === 'undefined'
    ) {
      return Promise.resolve(this.state);
    }

    if (any instanceof Promise) {
      return this.setPromise(any);
    }

    if (typeof any === 'function') {
      return this.setFunction(any);
    }

    if (typeof any === 'object') {
      return this.setObject(any);
    }

    throw INVALID_NEW_GLOBAL_STATE;
  }

  public setFunction(f: Function): Promise<GS> {
    return this.set(f(this.state));
  }

  // Set the state's property-value pairs via an object.
  public setObject(obj: Partial<GS>): Promise<GS> {
    const transactionId = this.beginTransaction();
    const properties: (keyof GS)[] = Object.keys(obj) as (keyof GS)[];
    for (const property of properties) {
      const value = obj[property];
      this.setProperty(property, value, transactionId);
    }
    this.commit(transactionId);
    return Promise.resolve(this.state);
  }

  // Set the state's property-value pairs via a promise.
  public setPromise(
    promise: Promise<NewGlobalState<GS>>
  ): Promise<GS> {
    return promise
      .then((result: NewGlobalState<GS>) => {
        return this.set(result);
      });
  }

  // Set a property-value pair as a part of a transaction.
  public setProperty<Property extends keyof GS>(
    property: Property,
    value: GS[Property],
    transactionId: number,
  ): number {

    // Silently ignore state properties that share names with reducers.
    // This can occur if you spread global state with reducers.
    // newGlobal = { ...globalWithReducers, newProperty: 'new value' }
    if (
      typeof property === 'string' &&
      this.hasReducer(property)
    ) {
      return transactionId;
    }

    const transaction: Transaction<GS> = this._transactions.get(transactionId);
    if (typeof value === 'undefined') {
      transaction.deleteProperty(property);
    }
    else {
      transaction.setProperty(property, value);
    }

    const propertyListeners: Set<PropertyListener> =
      this._propertyListeners.get(property);
    if (propertyListeners) {
      for (const propertyListener of propertyListeners) {
        transaction.addPropertyListener(propertyListener);
      }
    }

    return transactionId;
  }

  public spyState(propertyListener: PropertyListener): GS {

    // When this._state is read, execute the listener.
    return objectGetListener(
      this._state,
      property => {
        this.addPropertyListener(property, propertyListener);
      }
    );
  }

  public get state(): GS {
    return Object.assign(
      Object.create(null),
      this._state
    );
  }
};